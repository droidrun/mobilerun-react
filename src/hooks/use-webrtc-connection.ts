'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import type React from 'react';
import { useEffect, useRef, useState } from 'react';

import { createRTCConfigurationRequest } from '../webrtc-messages';

const debugLog = (...args: any[]) => {
  if (window.debugRemoteControl) {
    // eslint-disable-next-line no-console -- opt-in debug channel (window.debugRemoteControl)
    console.log(...args);
  }
};

const debugWarn = (...args: any[]) => {
  if (window.debugRemoteControl) {
    console.warn(...args);
  }
};

function buildWebSocketUrl(url: string, token?: string): string {
  if (!token) return url;

  const wsUrl = new URL(url, window.location.href);
  wsUrl.searchParams.set('token', token);
  return wsUrl.toString();
}

interface ScreenshotData {
  dataUri: string;
}

interface UseWebRtcConnectionOptions {
  url: string;
  token?: string;
  sessionId: string;
  openUrl?: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onConnectionStateChange?: (connected: boolean) => void;
  // Fired with the RTCPeerConnection once it is created and with null when
  // it is torn down. Lets consumers observe the connection (e.g. getStats())
  // without owning its lifecycle.
  onPeerConnectionChange?: (pc: RTCPeerConnection | null) => void;
}

interface UseWebRtcConnectionResult {
  wsRef: React.MutableRefObject<WebSocket | null>;
  dataChannelRef: React.MutableRefObject<RTCDataChannel | null>;
  hoverChannelRef: React.MutableRefObject<RTCDataChannel | null>;
  isConnected: boolean;
  pendingScreenshotResolversRef: React.MutableRefObject<
    Map<string, (value: ScreenshotData | PromiseLike<ScreenshotData>) => void>
  >;
  pendingScreenshotRejectersRef: React.MutableRefObject<Map<string, (reason?: any) => void>>;
}

export function useWebRtcConnection({
  url,
  token,
  sessionId,
  openUrl,
  videoRef,
  onConnectionStateChange,
  onPeerConnectionChange,
}: UseWebRtcConnectionOptions): UseWebRtcConnectionResult {
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const onConnectionStateChangeRef = useRef(onConnectionStateChange);
  onConnectionStateChangeRef.current = onConnectionStateChange;

  const onPeerConnectionChangeRef = useRef(onPeerConnectionChange);
  onPeerConnectionChangeRef.current = onPeerConnectionChange;

  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const hoverChannelRef = useRef<RTCDataChannel | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const keepAliveIntervalRef = useRef<number | undefined>(undefined);
  const pendingScreenshotResolversRef = useRef<
    Map<string, (value: ScreenshotData | PromiseLike<ScreenshotData>) => void>
  >(new Map());
  const pendingScreenshotRejectersRef = useRef<Map<string, (reason?: any) => void>>(new Map());
  const pendingIceCandidatesRef = useRef<RTCIceCandidate[]>([]);
  const remoteDescriptionSetRef = useRef(false);
  // Deadline (epoch ms) until which non-terminal connection-state dips are
  // suppressed: set when a credential-refresh ICE restart starts. Media keeps
  // flowing on the old candidate pair during the restart (make-before-break),
  // so reporting the transient 'connecting' would flicker the UI and trip
  // self-heal remounts (use-stream-self-heal) — the interruption the refresh
  // exists to avoid. 'failed'/'closed' always pass through.
  const iceRestartGraceUntilRef = useRef(0);
  // Pending re-check armed while a dip is being suppressed: state events only
  // fire on transitions, so a restart parked in 'connecting'/'disconnected'
  // past the grace deadline must be reported by this timer or the stream
  // would claim connected forever and self-heal would never start.
  const iceRestartRecheckTimerRef = useRef<number | undefined>(undefined);
  // Single combined stream we own — backend sends video and audio on
  // separate MediaStreams (different msid stream IDs), so we can't just
  // assign event.streams[0] or the second ontrack overwrites the first.
  const remoteStreamRef = useRef<MediaStream | null>(null);

  const updateStatus = (message: string) => {
    // Use the wrapper for conditional logging
    debugLog(message);
  };

  const clearRestartRecheck = () => {
    if (iceRestartRecheckTimerRef.current !== undefined) {
      window.clearTimeout(iceRestartRecheckTimerRef.current);
      iceRestartRecheckTimerRef.current = undefined;
    }
  };

  // Re-evaluates a suppressed connection-state dip once the ICE-restart grace
  // window expires. Rechecks against the pc captured at arm time so a torn
  // down or replaced connection is never reported on.
  const scheduleRestartRecheck = () => {
    if (iceRestartRecheckTimerRef.current !== undefined) return;
    const pcAtArm = peerConnectionRef.current;
    iceRestartRecheckTimerRef.current = window.setTimeout(
      () => {
        iceRestartRecheckTimerRef.current = undefined;
        if (!pcAtArm || peerConnectionRef.current !== pcAtArm) return;
        if (Date.now() < iceRestartGraceUntilRef.current) {
          // A newer restart extended the grace window; re-arm for it.
          scheduleRestartRecheck();
          return;
        }
        const state = pcAtArm.connectionState;
        if (state === 'connected') return;
        updateStatus('ICE-restart grace expired, reporting state: ' + state);
        setIsConnected(false);
        onConnectionStateChangeRef.current?.(false);
      },
      Math.max(0, iceRestartGraceUntilRef.current - Date.now()),
    );
  };

  const sendKeepAlive = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'keepAlive',
          sessionId: sessionId,
        }),
      );
    }
  };

  const startKeepAlive = () => {
    if (keepAliveIntervalRef.current) {
      window.clearInterval(keepAliveIntervalRef.current);
    }
    keepAliveIntervalRef.current = window.setInterval(sendKeepAlive, 10000);
  };

  const stopKeepAlive = () => {
    if (keepAliveIntervalRef.current) {
      window.clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = undefined;
    }
  };

  const handleVisibilityChange = () => {
    if (document.hidden) {
      stopKeepAlive();
    } else {
      startKeepAlive();
    }
  };

  const start = async () => {
    // Reset ICE buffering state for the new session.
    // Done here (not in stop()) to avoid a race where stale candidates
    // from the old WebSocket leak into the new peer connection.
    remoteDescriptionSetRef.current = false;
    pendingIceCandidatesRef.current = [];
    // A stale restart-grace window must not suppress the fresh peer
    // connection's early states after a remount.
    iceRestartGraceUntilRef.current = 0;
    clearRestartRecheck();
    try {
      const wsUrl = buildWebSocketUrl(url, tokenRef.current);
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onerror = (error) => {
        updateStatus('WebSocket error: ' + error);
      };

      wsRef.current.onclose = () => {
        updateStatus('WebSocket closed');
      };

      // Wait for WebSocket to connect
      await new Promise((resolve, reject) => {
        if (wsRef.current) {
          wsRef.current.onopen = resolve;
          setTimeout(() => reject(new Error('WebSocket connection timeout')), 30000);
        }
      });

      // Request RTCConfiguration
      const rtcConfigPromise = new Promise<RTCConfiguration>((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error('RTCConfiguration timeout')), 30000);

        const messageHandler = (event: MessageEvent) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'rtcConfiguration') {
              clearTimeout(timeoutId);
              wsRef.current?.removeEventListener('message', messageHandler);
              resolve(message.rtcConfiguration);
            }
          } catch (e) {
            console.error('Error handling RTC configuration:', e);
            reject(e);
          }
        };

        wsRef.current?.addEventListener('message', messageHandler);
        wsRef.current?.send(JSON.stringify(createRTCConfigurationRequest(sessionId)));
      });

      const rtcConfig = await rtcConfigPromise;
      peerConnectionRef.current = new RTCPeerConnection(rtcConfig);
      onPeerConnectionChangeRef.current?.(peerConnectionRef.current);
      peerConnectionRef.current.addTransceiver('audio', { direction: 'recvonly' });
      const videoTransceiver = peerConnectionRef.current.addTransceiver('video', {
        direction: 'recvonly',
      });

      // Ask the jitter buffer to target zero playout delay. Trades a bit of
      // smoothness for ~100ms lower glass-to-glass latency — critical for
      // cursor/touch responsiveness. Supported in Chromium and Safari; a
      // no-op elsewhere.
      try {
        (
          videoTransceiver.receiver as RTCRtpReceiver & { playoutDelayHint?: number }
        ).playoutDelayHint = 0;
      } catch {
        // Older browsers may not allow setting it; ignore.
      }

      // As hardware encoder, we use H265 for iOS and VP9 for Android.
      // We make sure these two are the first ones in the list.
      // If not, the fallback is H264 which is also hardware accelerated, although not as good,
      // available on all platforms.
      //
      // The rest is not important.
      if (RTCRtpReceiver.getCapabilities) {
        const capabilities = RTCRtpReceiver.getCapabilities('video');
        if (capabilities && capabilities.codecs) {
          const codecs = capabilities.codecs;
          const sortedCodecs = codecs.sort((a, b) => {
            const getCodecPriority = (codec: { mimeType: string }): number => {
              const mimeType = codec.mimeType.toLowerCase();
              if (mimeType.includes('vp9')) return 1;
              if (mimeType.includes('h265') || mimeType.includes('hevc')) return 2;
              if (mimeType.includes('h264') || mimeType.includes('avc')) return 3;
              return 4; // Everything else
            };
            return getCodecPriority(a) - getCodecPriority(b);
          });
          videoTransceiver.setCodecPreferences(sortedCodecs);
          debugLog('Set codec preferences:', sortedCodecs.map((c) => c.mimeType).join(', '));
        }
      }

      dataChannelRef.current = peerConnectionRef.current.createDataChannel('control', {
        ordered: true,
        negotiated: true,
        id: 1,
      });

      // Best-effort channel for hover updates: unordered, no retransmits.
      // Backend may not implement it; in that case sendHoverMessage falls
      // back to the reliable control channel.
      hoverChannelRef.current = peerConnectionRef.current.createDataChannel('hover', {
        ordered: false,
        maxRetransmits: 0,
        negotiated: true,
        id: 2,
      });
      hoverChannelRef.current.onopen = () => updateStatus('Hover channel opened');
      hoverChannelRef.current.onclose = () => updateStatus('Hover channel closed');
      hoverChannelRef.current.onerror = (error) => debugWarn('Hover channel error:', error);

      dataChannelRef.current.onopen = () => {
        updateStatus('Control channel opened');
        // Request first frame once we're ready to receive video
        if (wsRef.current) {
          for (let i = 0; i < 12; i++) {
            setTimeout(() => {
              if (wsRef.current) {
                wsRef.current.send(JSON.stringify({ type: 'requestFrame', sessionId: sessionId }));
              }
            }, i * 125); // 125ms = quarter second
          }

          // Send openUrl message if the prop is provided
          if (openUrl) {
            try {
              const decodedUrl = decodeURIComponent(openUrl);
              updateStatus('Opening URL');
              wsRef.current.send(
                JSON.stringify({
                  type: 'openUrl',
                  url: decodedUrl,
                  sessionId: sessionId,
                }),
              );
            } catch (error) {
              console.error({ error }, 'Error decoding URL, falling back to the original URL');
              wsRef.current.send(
                JSON.stringify({
                  type: 'openUrl',
                  url: openUrl,
                  sessionId: sessionId,
                }),
              );
            }
          }
        }
      };

      dataChannelRef.current.onclose = () => {
        updateStatus('Control channel closed');
      };

      dataChannelRef.current.onerror = (error) => {
        console.error('Control channel error:', error);
        updateStatus('Control channel error: ' + error);
      };

      // Set up connection state monitoring
      peerConnectionRef.current.onconnectionstatechange = () => {
        const state = peerConnectionRef.current?.connectionState;
        updateStatus('Connection state: ' + state);
        const connected = state === 'connected';
        if (connected) {
          iceRestartGraceUntilRef.current = 0;
        } else if (
          Date.now() < iceRestartGraceUntilRef.current &&
          state !== 'failed' &&
          state !== 'closed'
        ) {
          // A genuinely dead connection still surfaces: it reaches 'failed',
          // which always passes through, and the deadline re-check reports a
          // dip that outlives the grace window. A restart parked in
          // 'connecting' with media still flowing on the old pair is not a
          // disconnect.
          updateStatus('Suppressing transient state during ICE restart: ' + state);
          scheduleRestartRecheck();
          return;
        }
        clearRestartRecheck();
        setIsConnected(connected);
        onConnectionStateChangeRef.current?.(connected);
      };

      peerConnectionRef.current.oniceconnectionstatechange = () => {
        updateStatus('ICE state: ' + peerConnectionRef.current?.iceConnectionState);
      };

      // Build one combined stream and add each remote track into it.
      // event.streams[0] differs per track because the sender groups them
      // under separate msids, so re-assigning srcObject would clobber the
      // previous track. The audio track only plays if muted=false.
      peerConnectionRef.current.ontrack = (event) => {
        updateStatus('Received remote track: ' + event.track.kind);
        if (event.track.kind !== 'video' && event.track.kind !== 'audio') return;
        if (!videoRef.current) return;

        debugLog(`[${new Date().toISOString()}] ${event.track.kind} track received:`, event.track);

        if (!remoteStreamRef.current) {
          remoteStreamRef.current = new MediaStream();
          videoRef.current.srcObject = remoteStreamRef.current;
        }
        remoteStreamRef.current.addTrack(event.track);

        // If the consumer flipped muted=false before any track arrived,
        // the earlier muted-effect play() ran against an empty element
        // and the page's user activation may already be stale. Retry
        // now that there's actually media — succeeds if the gesture is
        // still in window, surfaces in debug logs otherwise so it's
        // clear why the stream stayed silent.
        if (!videoRef.current.muted) {
          videoRef.current.play().catch((err) => debugWarn('ontrack play() rejected:', err));
        }
      };

      // Handle ICE candidates
      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate && wsRef.current) {
          const message = {
            type: 'candidate',
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            sessionId: sessionId,
          };
          wsRef.current.send(JSON.stringify(message));
          updateStatus('Sent ICE candidate');
        } else {
          updateStatus('ICE candidate gathering completed');
        }
      };

      // Handle incoming messages
      // Capture the current WebSocket so stale messages from a previous
      // session (draining after stop()) are silently discarded.
      const currentWs = wsRef.current;
      currentWs.onmessage = async (event) => {
        if (wsRef.current !== currentWs) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (e) {
          debugWarn('Error parsing message:', e);
          return;
        }
        updateStatus('Received: ' + message.type);
        switch (message.type) {
          case 'answer':
            if (!peerConnectionRef.current) {
              updateStatus('No peer connection, skipping answer');
              break;
            }
            try {
              await peerConnectionRef.current.setRemoteDescription(
                new RTCSessionDescription({
                  type: 'answer',
                  sdp: message.sdp,
                }),
              );
            } catch (e) {
              // A stale answer (e.g. for a superseded ICE-restart offer) must
              // not kill this handler with an unhandled rejection; the
              // negotiation that produced the newer offer gets its own answer.
              debugWarn('setRemoteDescription failed, ignoring answer:', e);
              break;
            }
            // Session may have changed during the await
            if (wsRef.current !== currentWs) break;
            remoteDescriptionSetRef.current = true;
            updateStatus('Set remote description');
            // Flush any ICE candidates that arrived before the answer
            for (const candidate of pendingIceCandidatesRef.current) {
              if (wsRef.current !== currentWs) break;
              try {
                await peerConnectionRef.current.addIceCandidate(candidate);
                updateStatus('Added buffered ICE candidate');
              } catch (e) {
                debugWarn('Failed to add buffered ICE candidate:', e);
              }
            }
            pendingIceCandidatesRef.current = [];
            break;
          case 'candidate':
            if (!peerConnectionRef.current) {
              updateStatus('No peer connection, skipping candidate');
              break;
            }
            {
              const candidate = new RTCIceCandidate({
                candidate: message.candidate,
                sdpMid: message.sdpMid,
                sdpMLineIndex: message.sdpMLineIndex,
              });
              if (!remoteDescriptionSetRef.current) {
                pendingIceCandidatesRef.current.push(candidate);
                updateStatus('Buffered ICE candidate (waiting for remote description)');
              } else {
                try {
                  await peerConnectionRef.current.addIceCandidate(candidate);
                  updateStatus('Added ICE candidate');
                } catch (e) {
                  debugWarn('Failed to add ICE candidate:', e);
                }
              }
            }
            break;
          case 'screenshot':
            if (typeof message.id !== 'string' || typeof message.dataUri !== 'string') {
              debugWarn('Received invalid screenshot success message:', message);
              break;
            }
            const resolver = pendingScreenshotResolversRef.current.get(message.id);
            if (!resolver) {
              debugWarn(`Received screenshot data for unknown or handled id: ${message.id}`);
              break;
            }
            debugLog(`Received screenshot data for id ${message.id}`);
            resolver({ dataUri: message.dataUri });
            pendingScreenshotResolversRef.current.delete(message.id);
            pendingScreenshotRejectersRef.current.delete(message.id);
            break;
          case 'screenshotError':
            if (typeof message.id !== 'string' || typeof message.message !== 'string') {
              debugWarn('Received invalid screenshot error message:', message);
              break;
            }
            const rejecter = pendingScreenshotRejectersRef.current.get(message.id);
            if (!rejecter) {
              debugWarn(`Received screenshot error for unknown or handled id: ${message.id}`);
              break;
            }
            debugWarn(`Received screenshot error for id ${message.id}: ${message.message}`);
            rejecter(new Error(message.message));
            pendingScreenshotResolversRef.current.delete(message.id);
            pendingScreenshotRejectersRef.current.delete(message.id);
            break;
          case 'rtcConfiguration': {
            // Mid-session TURN credential refresh (stream-protocol §1.7): the
            // server re-minted ICE servers and already handed them to the
            // bridge. Apply them and restart ICE so both sides allocate with
            // the fresh credentials before the old ones expire; media
            // continues uninterrupted. (The initial rtcConfiguration reply is
            // consumed by the one-shot listener before this handler is
            // attached, so anything arriving here is a refresh.)
            const pc = peerConnectionRef.current;
            if (!pc || !message.rtcConfiguration?.iceServers) break;
            try {
              pc.setConfiguration({ iceServers: message.rtcConfiguration.iceServers });
            } catch (e) {
              debugWarn('rtcConfiguration refresh: setConfiguration failed, skipping ICE restart:', e);
              break;
            }
            iceRestartGraceUntilRef.current = Date.now() + 15_000;
            try {
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              if (wsRef.current === currentWs) {
                // New ICE generation: buffer incoming candidates until the
                // restart answer arrives. Applying them against the old
                // remote description rejects them on ufrag mismatch and
                // silently loses them — fatal on relay-only paths once the
                // old TURN allocation expires.
                remoteDescriptionSetRef.current = false;
                pendingIceCandidatesRef.current = [];
                currentWs.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, sessionId }));
                updateStatus('Sent ICE-restart offer (credential refresh)');
              }
            } catch (e) {
              iceRestartGraceUntilRef.current = 0;
              debugWarn('rtcConfiguration refresh: ICE restart failed:', e);
            }
            break;
          }
          default:
            debugWarn(`Received unhandled message type: ${message.type}`, message);
            break;
        }
      };

      // Create and send offer
      if (peerConnectionRef.current) {
        const offer = await peerConnectionRef.current.createOffer();
        await peerConnectionRef.current.setLocalDescription(offer);

        if (wsRef.current) {
          wsRef.current.send(
            JSON.stringify({
              type: 'offer',
              sdp: offer.sdp,
              sessionId: sessionId,
            }),
          );
        }
        updateStatus('Sent offer');
      }
    } catch (e) {
      updateStatus('Error: ' + e);
    }
  };

  const stop = () => {
    clearRestartRecheck();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (peerConnectionRef.current) {
      // Clear handler before close() to prevent spurious disconnect
      // callback on intentional teardown (unmount, URL change, etc.)
      peerConnectionRef.current.onconnectionstatechange = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
      onPeerConnectionChangeRef.current?.(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (remoteStreamRef.current) {
      for (const t of remoteStreamRef.current.getTracks()) {
        remoteStreamRef.current.removeTrack(t);
      }
      remoteStreamRef.current = null;
    }
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (hoverChannelRef.current) {
      hoverChannelRef.current.close();
      hoverChannelRef.current = null;
    }
    setIsConnected(false);
    updateStatus('Stopped');
  };

  useEffect(() => {
    // Start connection when component mounts
    start();

    // Only start keepAlive if page is visible
    if (!document.hidden) {
      startKeepAlive();
    }

    // Add visibility change listener
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Clean up
    return () => {
      stopKeepAlive();
      stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: reconnect only on url/session change; start/stop/keepAlive helpers are re-created each render and must not be deps
  }, [url, sessionId]);

  return {
    wsRef,
    dataChannelRef,
    hoverChannelRef,
    isConnected,
    pendingScreenshotResolversRef,
    pendingScreenshotRejectersRef,
  };
}
