const LOGITECH_VID = 0x046D;
const LOGITECH_PID = 0xC534;

let device = null;
let port = null;

document.getElementById('connectBtn').addEventListener('click', async () => {
  const btn = document.getElementById('connectBtn');
  const status = document.getElementById('status');
  
  if (port) {
    await port.close();
    port = null;
    device = null;
    btn.textContent = 'Connect';
    status.textContent = 'Disconnected';
    status.className = 'status disconnected';
    return;
  }
  
  try {
    const devices = await navigator.hid.getDevices();
    const logitechDevices = devices.filter(d => d.vendorId === LOGITECH_VID && d.productId === LOGITECH_PID);
    
    if (logitechDevices.length === 0) {
      const requested = await navigator.hid.requestDevice({
        filters: [{ vendorId: LOGITECH_VID, productId: LOGITECH_PID }]
      });
      if (requested.length === 0) return;
      device = requested[0];
    } else {
      device = logitechDevices[0];
    }
    
    await device.open();
    port = device;
    
    btn.textContent = 'Disconnect';
    status.textContent = 'Connected';
    status.className = 'status connected';
    
    port.oninputreport = handleInputReport;
    
    startCapture();
  } catch (e) {
    console.error(e);
    status.textContent = 'Error: ' + e.message;
    status.className = 'status disconnected';
  }
});

function handleInputReport(event) {
  const data = new DataView(event.data.buffer);
  const mouseMoving = data.getUint8(0) === 1;
  // Mouse movement state from RP2040 - used for trigger gating
  window.mouseMoving = mouseMoving;
}

async function startCapture() {
  const status = document.getElementById('status');
  status.textContent = 'Starting capture...';
  status.className = 'status scanning';
  
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60, cursor: 'never' },
      audio: false
    });
    
    const video = document.createElement('video');
    video.srcObject = stream;
    video.play();
    
    video.onloadedmetadata = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      const cropSize = 320;
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const cropX = centerX - cropSize / 2;
      const cropY = centerY - cropSize / 2;
      
      let lastSample = 0;
      let sampleCount = 0;
      let targetLocked = false;
      let lastCentroid = { x: 160, y: 160 };
      let reactionDelay = 0;
      let reactionStart = 0;
      let strength = 0.5;
      let deadzone = 5;
      let correctionsRemaining = 0;
      let correctionQueue = [];
      let overshootActive = false;
      let overshootCorrections = 0;
      
      function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0, v = max;
        const d = max - min;
        s = max === 0 ? 0 : d / max;
        if (max !== min) {
          switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
          }
          h *= 60;
        }
        return { h, s, v };
      }
      
      function detectTarget(imageData) {
        const hueMin = parseFloat(document.getElementById('hueMin').value);
        const hueMax = parseFloat(document.getElementById('hueMax').value);
        const satMin = parseFloat(document.getElementById('satMin').value);
        const valMin = parseFloat(document.getElementById('valMin').value);
        
        const hits = [];
        const searchSize = targetLocked ? 64 : 320;
        const searchX = targetLocked ? Math.max(0, Math.min(256, lastCentroid.x - 32)) : 0;
        const searchY = targetLocked ? Math.max(0, Math.min(256, lastCentroid.y - 32)) : 0;
        
        for (let y = searchY; y < searchY + searchSize; y += 2) {
          for (let x = searchX; x < searchX + searchSize; x += 2) {
            const i = (y * 320 + x) * 4;
            const { h, s, v } = rgbToHsv(
              imageData.data[i],
              imageData.data[i + 1],
              imageData.data[i + 2]
            );
            
            const hueMatch = (h >= hueMin && h <= 360) || (h >= 0 && h <= hueMax);
            if (hueMatch && s > satMin && v > valMin) {
              hits.push({ x: x - 160, y: y - 160 });
            }
          }
        }
        
        if (hits.length < 3) return null;
        
        let cx = 0, cy = 0;
        for (const h of hits) { cx += h.x; cy += h.y; }
        cx /= hits.length; cy /= hits.length;
        
        let spreadX = 0, spreadY = 0;
        for (const h of hits) {
          spreadX += (h.x - cx) ** 2;
          spreadY += (h.y - cy) ** 2;
        }
        spreadX = Math.sqrt(spreadX / hits.length);
        spreadY = Math.sqrt(spreadY / hits.length);
        
        if (spreadX > 80 || spreadY > 80) return null;
        
        return { x: cx, y: cy };
      }
      
      function humanizeAndQueue(centroid) {
        const dx = centroid.x;
        const dy = centroid.y;
        
        if (Math.abs(dx) < deadzone && Math.abs(dy) < deadzone) return;
        
        if (reactionDelay === 0) {
          reactionDelay = 90 + Math.random() * 150;
          reactionStart = performance.now();
          strength = 0.4 + Math.random() * 0.3;
          deadzone = 3 + Math.floor(Math.random() * 6);
          correctionsRemaining = 3 + Math.floor(Math.random() * 5);
          
          if (Math.random() < 0.15) {
            overshootActive = true;
            overshootCorrections = 2 + Math.floor(Math.random() * 2);
          }
          return;
        }
        
        if (performance.now() - reactionStart < reactionDelay) return;
        
        const remaining = correctionsRemaining--;
        const total = 3 + Math.floor(Math.random() * 5);
        const progress = 1 - remaining / total;
        const easeOut = 1 - (1 - progress) ** 2;
        
        let cdx = dx * strength * easeOut;
        let cdy = dy * strength * 0.85 * easeOut;
        
        if (overshootActive && overshootCorrections > 0) {
          const overshootFactor = 1 + (0.04 + Math.random() * 0.08);
          cdx *= overshootFactor;
          cdy *= overshootFactor;
          overshootCorrections--;
          if (overshootCorrections === 0) overshootActive = false;
        }
        
        cdx += (Math.random() - 0.5) * 1.6;
        cdy += (Math.random() - 0.5) * 1.6;
        
        correctionQueue.push({
          dx: Math.round(cdx),
          dy: Math.round(cdy)
        });
      }
      
      function sendNextCorrection() {
        if (correctionQueue.length === 0) return;
        
        if (!window.mouseMoving && performance.now() - reactionStart > 500) {
          return;
        }
        
        const correction = correctionQueue.shift();
        if (port) {
          const buf = new ArrayBuffer(5);
          const view = new DataView(buf);
          view.setInt16(0, correction.dx, true);
          view.setInt16(2, correction.dy, true);
          view.setUint8(4, 0);
          port.sendReport(0, new Uint8Array(buf));
        }
      }
      
      let lastFrameTime = 0;
      function frameLoop(now) {
        if (!video.videoWidth) return requestAnimationFrame(frameLoop);
        
        const interval = 12 + Math.random() * 6;
        const shouldSkip = Math.random() < 0.07;
        
        if (now - lastFrameTime >= interval && !shouldSkip) {
          lastFrameTime = now;
          
          ctx.drawImage(video, cropX, cropY, cropSize, cropSize, 0, 0, cropSize, cropSize);
          const imageData = ctx.getImageData(0, 0, cropSize, cropSize);
          
          const target = detectTarget(imageData);
          
          if (target) {
            targetLocked = true;
            lastCentroid = target;
            
            if (sampleCount < 5) sampleCount++;
            
            if (correctionQueue.length === 0 && !reactionDelay) {
              humanizeAndQueue(target);
            }
          } else {
            if (++sampleCount > 10) {
              targetLocked = false;
              sampleCount = 0;
              reactionDelay = 0;
              correctionQueue = [];
            }
          }
          
          sendNextCorrection();
        }
        
        requestAnimationFrame(frameLoop);
      }
      
      requestAnimationFrame(frameLoop);
    };
    
  } catch (e) {
    console.error(e);
    status.textContent = 'Capture error: ' + e.message;
    status.className = 'status disconnected';
  }
}