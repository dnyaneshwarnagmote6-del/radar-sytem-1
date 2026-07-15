(function(){
  "use strict";

  // ---------- CONFIG ----------
  const MAX_DISTANCE = 40;     // cm, outer ring (match this to your sensor's usable range)
  const RING_COUNT   = 4;
  const SWEEP_SPEED  = 60;     // degrees per second, oscillates 0 <-> 180 like the servo
  const TARGET_LIFE  = 1400;   // ms before a blip fully fades

  // ---------- DOM ----------
  const canvas   = document.getElementById('radarCanvas');
  const ctx      = canvas.getContext('2d');
  const stage    = document.getElementById('stage');
  const connBtn  = document.getElementById('connectBtn');
  const soundBtn = document.getElementById('soundBtn');
  const connDot  = document.getElementById('connDot');
  const connText = document.getElementById('connText');
  const fpsVal   = document.getElementById('fpsVal');
  const angleVal = document.getElementById('angleVal');
  const distVal  = document.getElementById('distVal');
  const modeVal  = document.getElementById('modeVal');
  const targetVal= document.getElementById('targetVal');
  const banner   = document.getElementById('statusBanner');

  // ---------- STATE ----------
  let cx=0, cy=0, radius=0;
  let sweepAngle = 0;           // 0-180, oscillates like the physical servo
  let sweepDir = 1;             // +1 sweeping toward 180, -1 sweeping back toward 0
  let currentAngle = 0;         // last reported sensor angle
  let currentDistance = 0;
  let objectDetected = false;
  let targets = [];             // {angle, dist, bornAt}
  let connected = false;
  let simulating = true;
  let port=null, reader=null, keepReading=false;
  let soundEnabled = true;
  let audioCtx = null;
  let lastBeepAt = 0;
  let wasDetected = false;

  let lastTime = performance.now();
  let fpsSmoothed = 60;

  // ---------- CANVAS SIZING ----------
  function resize(){
    const dpr = window.devicePixelRatio || 1;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);

    // center sits near the BOTTOM of the stage: classic half-circle radar
    cx = w/2;
    cy = h - Math.min(h*0.14, 60);
    radius = Math.min(w*0.46, cy*0.88);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- ANGLE -> XY (half circle, 0deg=right, 180deg=left) ----------
  function pointAt(angleDeg, r){
    const rad = (180 - angleDeg) * Math.PI/180;
    return {
      x: cx + r*Math.cos(rad),
      y: cy - r*Math.sin(rad)
    };
  }

  // ---------- DRAWING ----------
  function drawGrid(){
    ctx.save();
    ctx.strokeStyle = 'rgba(51,255,119,0.28)';
    ctx.lineWidth = 1;
    ctx.font = '11px "Share Tech Mono"';
    ctx.fillStyle = 'rgba(51,255,119,0.55)';

    // distance rings (each drawn as a 0-180 polyline so geometry always matches pointAt)
    for(let i=1;i<=RING_COUNT;i++){
      const r = radius * i/RING_COUNT;
      ctx.beginPath();
      for(let a=0;a<=180;a+=2){
        const p = pointAt(a, r);
        if(a===0) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y);
      }
      ctx.stroke();

      const label = Math.round(MAX_DISTANCE * i/RING_COUNT) + 'cm';
      const lp = pointAt(90, r);
      ctx.fillText(label, lp.x+6, lp.y-4);
    }

    // radial spokes every 30deg across the half circle, labeled
    for(let a=0;a<=180;a+=30){
      const p1 = {x:cx, y:cy};
      const p2 = pointAt(a, radius);
      ctx.beginPath();
      ctx.moveTo(p1.x,p1.y);
      ctx.lineTo(p2.x,p2.y);
      ctx.stroke();

      const lp = pointAt(a, radius+18);
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.fillText(a+'\u00B0', lp.x, lp.y);
    }

    // baseline
    const left = pointAt(180, radius);
    const right = pointAt(0, radius);
    ctx.strokeStyle = 'rgba(51,255,119,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.stroke();

    ctx.restore();
  }

  function drawSweep(){
    const tip = pointAt(sweepAngle, radius);

    ctx.save();
    // glow wedge trailing behind the sweep line, in the direction it came from
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    const trailA = sweepDir > 0 ? sweepAngle - 8 : sweepAngle + 8;
    const trailP = pointAt(Math.max(0, Math.min(180, trailA)), radius);
    ctx.lineTo(trailP.x, trailP.y);
    for(let a=trailA; sweepDir>0 ? a<=sweepAngle : a>=sweepAngle; a += sweepDir>0?1:-1){
      const p = pointAt(Math.max(0,Math.min(180,a)), radius);
      ctx.lineTo(p.x,p.y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(51,255,119,0.10)';
    ctx.fill();

    // beam line with layered glow
    for(let i=6;i>=1;i--){
      ctx.strokeStyle = `rgba(51,255,119,${0.05*i})`;
      ctx.lineWidth = i*2;
      ctx.beginPath();
      ctx.moveTo(cx,cy);
      ctx.lineTo(tip.x,tip.y);
      ctx.stroke();
    }
    ctx.strokeStyle = '#c9ffda';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.lineTo(tip.x,tip.y);
    ctx.stroke();
    ctx.restore();
  }

  function drawTargets(now){
    ctx.save();
    targets = targets.filter(t => (now - t.bornAt) < TARGET_LIFE);
    targetVal.textContent = targets.length;

    for(const t of targets){
      const age = (now - t.bornAt) / TARGET_LIFE; // 0 -> 1
      const alpha = 1 - age;
      const r = Math.min(t.dist, MAX_DISTANCE) / MAX_DISTANCE * radius;
      const p = pointAt(t.angle, r);

      for(let g=4; g>=1; g--){
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,80,90,${0.12*alpha})`;
        ctx.arc(p.x,p.y, g*6, 0, Math.PI*2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.fillStyle = `rgba(255,110,120,${alpha})`;
      ctx.arc(p.x,p.y, 4, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCenter(){
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = 'rgba(51,255,119,0.9)';
    ctx.arc(cx,cy,3,0,Math.PI*2);
    ctx.fill();
    ctx.restore();
  }

  function addTarget(angle, dist){
    if(dist<=0 || dist>MAX_DISTANCE) return;
    targets.push({angle, dist, bornAt: performance.now()});
    if(targets.length>300) targets.shift();
  }

  // ---------- SOUND + VIBRATION ALERTS ----------
  function unlockAudio(){
    if(audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    audioCtx = new AC();
  }

  function beep(freq, duration){
    if(!soundEnabled || !audioCtx) return;
    if(audioCtx.state === 'suspended') audioCtx.resume();

    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;

    const now = audioCtx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  // proximity-based ping: closer objects beep faster and higher, like a parking sensor
  function updateAlertFeedback(now){
    if(!objectDetected){
      wasDetected = false;
      return;
    }
    const proximity = 1 - Math.min(currentDistance, MAX_DISTANCE)/MAX_DISTANCE; // 0 far -> 1 close
    const interval = 650 - proximity*500;   // 650ms far down to ~150ms close
    const freq = 700 + proximity*500;       // 700Hz far up to ~1200Hz close

    if(!wasDetected || (now - lastBeepAt) >= interval){
      beep(freq, 0.09);
      if(navigator.vibrate) navigator.vibrate(proximity > 0.6 ? 60 : 35);
      lastBeepAt = now;
    }
    wasDetected = true;
  }

  function setSoundUI(){
    soundBtn.textContent = soundEnabled ? '\u{1F50A}' : '\u{1F507}';
    soundBtn.classList.toggle('muted', !soundEnabled);
  }
  soundBtn.addEventListener('click', () => {
    unlockAudio();
    soundEnabled = !soundEnabled;
    setSoundUI();
  });
  document.addEventListener('pointerdown', unlockAudio, { once:true });
  setSoundUI();

  // ---------- SIMULATION (fallback when no serial connection) ----------
  function simulateStep(){
    const t = performance.now()*0.0006;
    const n = (Math.sin(t*1.7 + sweepAngle*0.05) + Math.sin(t*0.8)) * 0.5;
    currentAngle = sweepAngle;
    currentDistance = MAX_DISTANCE * (0.5 + n*0.5);
    objectDetected = currentDistance < MAX_DISTANCE*0.5;
    if(objectDetected && Math.random() < 0.25){
      addTarget(currentAngle, currentDistance);
    }
  }

  // ---------- MAIN LOOP ----------
  function frame(now){
    const dt = (now - lastTime)/1000;
    lastTime = now;

    const instFps = 1/Math.max(dt, 0.0001);
    fpsSmoothed += (instFps - fpsSmoothed) * 0.1;

    // oscillate 0 <-> 180, matching the physical servo sweep
    sweepAngle += sweepDir * SWEEP_SPEED * dt;
    if(sweepAngle >= 180){ sweepAngle = 180; sweepDir = -1; }
    if(sweepAngle <= 0){ sweepAngle = 0; sweepDir = 1; }

    if(simulating) simulateStep();

    // trail fade instead of hard clear -> phosphor persistence look
    ctx.save();
    ctx.setTransform(window.devicePixelRatio||1,0,0,window.devicePixelRatio||1,0,0);
    ctx.fillStyle = 'rgba(3,8,5,0.16)';
    ctx.fillRect(0,0, canvas.width, canvas.height);
    ctx.restore();

    drawGrid();
    drawSweep();
    drawTargets(now);
    drawCenter();

    // HUD text updates
    fpsVal.textContent = Math.round(fpsSmoothed);
    angleVal.textContent = currentAngle.toFixed(1) + '\u00B0';
    distVal.textContent = (currentDistance>0 ? currentDistance.toFixed(1) : '--.-') + ' cm';

    if(objectDetected){
      banner.textContent = 'OBJECT DETECTED';
      banner.classList.add('armed');
      stage.classList.add('alert');
    } else {
      banner.textContent = 'SCANNING';
      banner.classList.remove('armed');
      stage.classList.remove('alert');
    }
    updateAlertFeedback(now);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------- WEB SERIAL ----------
  const hasSerial = 'serial' in navigator;

  function setConnectedUI(isConnected){
    connected = isConnected;
    simulating = !isConnected;
    modeVal.textContent = isConnected ? 'LIVE' : 'SIM';
    connBtn.textContent = isConnected ? 'DISCONNECT' : 'CONNECT ARDUINO';
    connBtn.classList.toggle('connected', isConnected);
    connDot.classList.toggle('live', isConnected);
    connText.textContent = isConnected ? 'ONLINE' : 'OFFLINE';
  }

  async function connectSerial(){
    if(!hasSerial){
      alert('Web Serial API is not available in this browser.\nUse Chrome or Edge, served over HTTPS or localhost.\nContinuing in simulation mode.');
      return;
    }
    try{
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 9600 });
      setConnectedUI(true);
      keepReading = true;
      readLoop();
    }catch(err){
      console.warn('Serial connection cancelled or failed:', err);
    }
  }

  async function disconnectSerial(){
    keepReading = false;
    try{
      if(reader){ await reader.cancel(); }
      if(port){ await port.close(); }
    }catch(err){ console.warn(err); }
    port=null; reader=null;
    setConnectedUI(false);
  }

  async function readLoop(){
    const textDecoder = new TextDecoderStream();
    const readableClosed = port.readable.pipeTo(textDecoder.writable);
    reader = textDecoder.readable.getReader();

    let buffer = '';
    try{
      while(keepReading){
        const { value, done } = await reader.read();
        if(done) break;
        buffer += value;

        // packets are terminated with "." (see arduino_radar_scanner_fixed.ino)
        let dotIdx;
        while((dotIdx = buffer.indexOf('.')) >= 0){
          const packet = buffer.slice(0, dotIdx).trim();
          buffer = buffer.slice(dotIdx+1);
          parsePacket(packet);
        }
      }
    }catch(err){
      console.warn('Serial read error:', err);
    }finally{
      reader.releaseLock();
    }
  }

  function parsePacket(packet){
    const parts = packet.split(',');
    if(parts.length < 2) return;
    const a = parseFloat(parts[0]);
    const d = parseFloat(parts[1]);
    if(Number.isNaN(a) || Number.isNaN(d)) return;

    currentAngle = Math.max(0, Math.min(180, a));
    currentDistance = d;
    objectDetected = d>0 && d<=MAX_DISTANCE;
    if(objectDetected) addTarget(currentAngle, currentDistance);
  }

  connBtn.addEventListener('click', () => {
    if(connected){ disconnectSerial(); }
    else{ connectSerial(); }
  });

  setConnectedUI(false);
})();
