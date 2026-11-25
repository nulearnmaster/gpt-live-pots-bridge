const startButton = document.querySelector('#start');
const endButton = document.querySelector('#end');
const playButton = document.querySelector('#play');
const status = document.querySelector('#status');
const audio = document.querySelector('#audio');
let authorized = false;
let trustedOwner = false;
let live;

function layout() {
  startButton.hidden = Boolean(live);
  startButton.disabled = !authorized;
  endButton.hidden = !live;
  endButton.disabled = Boolean(live?.closing);
  playButton.hidden = !live?.playBlocked || Boolean(live?.closing);
  document.documentElement.toggleAttribute('data-live', Boolean(live?.ready && !live?.closing));
}
function message(text) { status.textContent = text; layout(); }
function post(path, data, options) {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', body: JSON.stringify(data), ...options });
}
const stopTracks = (stream) => stream?.getTracks().forEach((track) => track.stop());
function dispose(run, text) {
  if (live !== run) return;
  live = undefined;
  run.abort.abort();
  clearTimeout(run.setupTimer);
  clearTimeout(run.closeTimer);
  clearTimeout(run.disconnectTimer);
  clearInterval(run.leaseTimer);
  stopTracks(run.mic);
  run.events?.close();
  run.peer?.close();
  audio.pause();
  audio.srcObject = null;
  message(text);
}
const ended = '대화가 끝났어요. 접수된 작업은 계속됩니다.';
const uncertain = '마이크가 꺼졌어요. 서버의 종료 확인을 받지 못했습니다.';
const leftPage = '페이지를 벗어나 연결을 닫았어요.';
function finish(run, reason, unload = false) {
  if (run !== live) return;
  // Stop capturing immediately, but keep the WebRTC connection open briefly
  // for the sideband's session.close / session.closed sequence when possible.
  stopTracks(run.mic);
  if (run.closing) { if (unload) dispose(run, uncertain); return; }
  run.closing = true;
  audio.pause();
  audio.srcObject = null;
  run.abort.abort();
  clearTimeout(run.setupTimer);
  clearInterval(run.leaseTimer);
  if (!run.sentOffer) { dispose(run, reason || '연결을 취소했어요.'); return; }
  message('대화를 종료하는 중…');
  run.closeTimer = setTimeout(() => dispose(run, uncertain), 8000);
  void post('/api/end', run.permit ? { permit: run.permit } : {}, { keepalive: true }).then((res) => {
    // A provider session.closed event may arrive before the HTTP response.
    if (res.status === 204) dispose(run, reason || ended);
    else if (res.status !== 401) dispose(run, uncertain);
  }).catch(() => dispose(run, uncertain));
  if (unload) dispose(run, leftPage);
}
function foreground(run) {
  if (run !== live || run.closing) return false;
  if (document.hidden) { finish(run, leftPage); return false; }
  return true;
}
function waitForICE(peer, signal) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    function done(error) {
      clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', changed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    }
    const changed = () => { if (peer.iceGatheringState === 'complete') done(); };
    const aborted = () => done(Error('cancelled'));
    const timeout = setTimeout(() => done(Error('ICE setup timed out')), 10000);
    peer.addEventListener('icegatheringstatechange', changed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else changed();
  });
}
function ready(run) {
  if (!foreground(run) || run.ready || !run.started || run.peer.connectionState !== 'connected') return;
  run.ready = true;
  clearTimeout(run.setupTimer);
  for (const track of run.mic.getAudioTracks()) track.enabled = true;
  message(run.playBlocked ? '연결됐어요. 소리를 켜 주세요.' : '연결됐어요. 바로 말씀하세요.');
}
async function play(run) {
  if (!foreground(run) || !audio.srcObject) return;
  try {
    // For a blocked autoplay, this is called synchronously from the Play tap.
    await audio.play();
    if (!foreground(run)) return;
    run.playBlocked = false;
    if (run.ready) message('연결됐어요. 바로 말씀하세요.'); else layout();
  } catch {
    if (!foreground(run)) return;
    run.playBlocked = true;
    message('소리가 자동으로 재생되지 않았어요. 소리를 켜 주세요.');
  }
}
async function begin() {
  if (live || !authorized || document.hidden) return;
  const run = { abort: new AbortController() };
  live = run;
  message('마이크 접근을 허용해 주세요…');
  run.setupTimer = setTimeout(() => finish(run, '연결 시간이 초과됐어요.'), 25000);
  try {
    // The explicit cost-and-start tap calls getUserMedia before the first await;
    // there is no automatic microphone request, recording or turn upload.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (!foreground(run)) { stopTracks(stream); return; }
    run.mic = stream;
    message('음성을 연결하는 중…');
    const peer = new RTCPeerConnection();
    run.peer = peer;
    for (const track of stream.getAudioTracks()) {
      track.enabled = false; // Unmuted only when the authorized session is ready.
      peer.addTrack(track, stream); // Bidirectional throughout conversation; no turn gating.
      track.addEventListener('ended', () => finish(run, '마이크 연결이 끊어졌어요.'));
    }
    peer.addEventListener('track', (event) => {
      if (!foreground(run) || event.track.kind !== 'audio') return;
      audio.srcObject = new MediaStream([event.track]);
      void play(run);
    });
    peer.addEventListener('connectionstatechange', () => {
      if (run !== live || run.closing) return;
      clearTimeout(run.disconnectTimer);
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') finish(run, '연결이 끊어졌어요.');
      else if (peer.connectionState === 'disconnected') {
        run.disconnectTimer = setTimeout(() => finish(run, '연결이 끊어졌어요.'), 4000);
      } else ready(run);
    });
    const events = peer.createDataChannel('oai-events');
    run.events = events;
    events.addEventListener('close', () => finish(run, '연결이 끊어졌어요.'));
    events.addEventListener('message', ({ data }) => {
      if (run !== live || typeof data !== 'string' || data.length > 65536) return;
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (event?.type === 'session.started') { run.started = true; ready(run); }
      else if (event?.type === 'session.closed') dispose(run, ended);
    });
    await peer.setLocalDescription(await peer.createOffer());
    await waitForICE(peer, run.abort.signal);
    if (!foreground(run)) return;
    if (trustedOwner) {
      // One invisible, tab-local permit for this button press. Not a saved
      // login or billing mandate; without it a stale End can't affect new calls.
      const preparation = await post('/api/prepare', { consent: true }, { signal: run.abort.signal });
      if (!foreground(run)) return;
      if (!preparation.ok) { dispose(run, '지금은 연결할 수 없어요. 잠시 후 다시 시작해 주세요.'); return; }
      const { permit } = await preparation.json();
      if (!/^[A-Za-z0-9_-]{43}$/.test(permit)) throw Error('invalid call permit');
      run.permit = permit;
    }
    if (!foreground(run)) return; // A billable POST must never start from a hidden page.
    run.sentOffer = true;
    if (!trustedOwner) authorized = false;
    const scope = run.permit ? { permit: run.permit } : {};
    const response = await post('/api/session', { sdp: peer.localDescription.sdp, consent: true, ...scope }, { signal: run.abort.signal });
    if (response.status === 409 || response.status === 429) {
      dispose(run, '지금은 연결할 수 없어요. 잠시 후 다시 시작해 주세요.'); return;
    }
    if (!response.ok) throw Error('unable to initiate session');
    const { sdp } = await response.json();
    if (!foreground(run)) return;
    await peer.setRemoteDescription({ type: 'answer', sdp });
    if (!foreground(run)) return;
    run.leaseTimer = setInterval(async () => {
      try {
        const reply = await post('/api/lease', scope, { signal: run.abort.signal });
        if (!reply.ok) finish(run, '연결이 종료됐어요.');
      } catch { if (!run.closing) finish(run, '연결이 끊어졌어요.'); }
    }, 5000);
  } catch (error) {
    if (run !== live || run.closing) return;
    if (!run.mic) dispose(run, error?.name === 'NotAllowedError' ? '브라우저 설정에서 마이크를 허용한 후 다시 시작해 주세요.'
      : '마이크를 사용할 수 없어요. 휴대폰 설정을 확인해 주세요.');
    else finish(run, trustedOwner ? '연결하지 못했어요. 비공개 네트워크를 확인해 주세요.' : '연결하지 못했어요. 초대와 네트워크를 확인해 주세요.');
  }
}
startButton.addEventListener('click', begin);
endButton.addEventListener('click', () => { if (live) finish(live); });
playButton.addEventListener('click', () => void play(live));
addEventListener('pagehide', () => { if (live) finish(live, '', true); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && live) finish(live, leftPage);
});

async function authorize() {
  const match = /^#invite=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    message('HTTPS에서 Safari 또는 Chrome으로 열어 주세요.'); return;
  }
  try {
    if (match) authorized = (await post('/api/invite', { invite: match[1] })).status === 204;
    else trustedOwner = authorized = (await post('/api/owner', {})).status === 204;
  } catch { /* remain disarmed */ }
  message(authorized ? '시작하면 마이크가 켜지고 AI와 연결돼요.'
    : match ? '초대가 만료됐거나 이미 사용됐어요.' : '개인 링크 또는 비공개 접속 권한을 확인해 주세요.');
}
void authorize();
