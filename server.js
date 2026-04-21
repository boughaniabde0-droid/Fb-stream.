const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { spawn }  = require('child_process');
const { v4: uuid } = require('uuid');

const PORT = process.env.PORT || 3000;

/* ═══════════════════════════════════════
   IN-MEMORY STREAM STORE
═══════════════════════════════════════ */
const streams   = {};   // id -> stream info
const processes = {};   // id -> ffmpeg child process
const clients   = new Set(); // WebSocket connections
let   totalToday = 0;

/* ═══════════════════════════════════════
   QUALITY PRESETS
═══════════════════════════════════════ */
const QUALITY = {
  copy:       { video: 'copy',   audio: 'copy',   scale: null,       bitrate: null },
  '360p':     { video: 'libx264',audio: 'aac',    scale: '640:360',  bitrate: '700k' },
  '480p':     { video: 'libx264',audio: 'aac',    scale: '854:480',  bitrate: '1200k' },
  '720p':     { video: 'libx264',audio: 'aac',    scale: '1280:720', bitrate: '2500k' },
  '1080p':    { video: 'libx264',audio: 'aac',    scale: '1920:1080',bitrate: '5000k' },
  '1080p_high':{ video:'libx264',audio: 'aac',    scale: '1920:1080',bitrate: '8000k' },
};

const AUDIO = {
  copy:    ['copy'],
  aac_128: ['aac','-b:a','128k','-ar','44100'],
  aac_192: ['aac','-b:a','192k','-ar','44100'],
  aac_256: ['aac','-b:a','256k','-ar','44100'],
};

const WM_SIZE = { small:'iw*0.10', medium:'iw*0.20', large:'iw*0.30', xlarge:'iw*0.40' };
const WM_POS  = {
  top_right:    ['W-w-20','20'],
  top_left:     ['20','20'],
  bottom_right: ['W-w-20','H-h-20'],
  bottom_left:  ['20','H-h-20'],
  center:       ['(W-w)/2','(H-h)/2'],
};

/* ═══════════════════════════════════════
   BUILD FFMPEG ARGS
═══════════════════════════════════════ */
function buildFFmpegArgs(opts) {
  const q     = QUALITY[opts.quality] || QUALITY.copy;
  const aArgs = AUDIO[opts.audio]     || ['copy'];
  const args  = [
    '-re',
    '-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','5',
    '-i', opts.source_url,
  ];

  // Watermark
  if (opts.watermark_enabled && opts.watermark_path) {
    args.push('-i', opts.watermark_path);
    const wmSize = WM_SIZE[opts.watermark_size] || WM_SIZE.medium;
    const wmPos  = WM_POS[opts.watermark_position] || WM_POS.top_right;
    const alpha  = parseFloat(opts.watermark_opacity) || 0.8;
    const filter = q.scale
      ? `[0:v]scale=${q.scale}[scaled];[1:v]scale=${wmSize}:-1[wm];[scaled][wm]overlay=${wmPos[0]}:${wmPos[1]}:alpha=${alpha}[v]`
      : `[1:v]scale=${wmSize}:-1[wm];[0:v][wm]overlay=${wmPos[0]}:${wmPos[1]}:alpha=${alpha}[v]`;
    args.push('-filter_complex', filter, '-map','[v]','-map','0:a');
  } else if (q.scale) {
    args.push('-vf', `scale=${q.scale}`);
  }

  // Video codec
  args.push('-c:v', q.video);
  if (q.video !== 'copy') {
    args.push('-preset','veryfast','-tune','zerolatency');
    if (q.bitrate) args.push('-b:v', q.bitrate, '-maxrate', q.bitrate, '-bufsize', q.bitrate.replace('k','')+'k');
  }
  if (q.video !== 'copy' && opts.fps) args.push('-r', opts.fps, '-g', String(parseInt(opts.fps)*2));

  // Audio codec
  args.push('-c:a', ...aArgs);

  // Output
  args.push('-f','flv', opts.stream_key);
  return args;
}

/* ═══════════════════════════════════════
   START STREAM
═══════════════════════════════════════ */
function startFFmpeg(id, opts, delaySeconds=0) {
  setTimeout(() => {
    const args = buildFFmpegArgs(opts);
    console.log(`[STREAM ${id.slice(0,8)}] ffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore','pipe','pipe'] });
    processes[id] = proc;

    proc.stderr.on('data', chunk => {
      const line = chunk.toString();
      // Only log key info lines
      if (line.includes('frame=') || line.includes('Error') || line.includes('error')) {
        console.log(`[${id.slice(0,8)}] ${line.trim()}`);
      }
    });

    proc.on('close', code => {
      console.log(`[STREAM ${id.slice(0,8)}] ended (code ${code})`);
      const name = streams[id] ? streams[id].name : id;
      delete processes[id];
      if (streams[id]) {
        const info = streams[id];
        delete streams[id];
        broadcast({ type:'stream_ended', stream_id:id, name });
        // cleanup watermark temp file
        if (info.watermark_path && info.watermark_path.startsWith('/tmp/')) {
          fs.unlink(info.watermark_path, ()=>{});
        }
      }
    });

    proc.on('error', err => {
      broadcast({ type:'stream_error', stream_id:id, name: streams[id]?.name||id, error: err.message });
    });

    streams[id].pid = proc.pid;
    broadcast({ type:'stream_started', stream_id:id, ...streams[id] });
  }, delaySeconds * 1000);
}

/* ═══════════════════════════════════════
   PARSE MULTIPART FORM DATA (no deps)
═══════════════════════════════════════ */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let body = Buffer.alloc(0);
    req.on('data', chunk => body = Buffer.concat([body, chunk]));
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      const boundary = ct.split('boundary=')[1];
      if (!boundary) return resolve({ fields:{}, files:{} });

      const fields = {}, files = {};
      const sep = Buffer.from('--' + boundary);
      const parts = [];
      let start = body.indexOf(sep) + sep.length + 2; // skip \r\n

      while (start < body.length) {
        const end = body.indexOf(sep, start);
        if (end === -1) break;
        parts.push(body.slice(start, end - 2)); // strip trailing \r\n
        start = end + sep.length + 2;
      }

      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headerStr = part.slice(0, headerEnd).toString();
        const content   = part.slice(headerEnd + 4);
        const cdMatch   = headerStr.match(/Content-Disposition:.*?name="([^"]+)"(?:.*?filename="([^"]+)")?/i);
        if (!cdMatch) continue;
        const name = cdMatch[1], filename = cdMatch[2];
        if (filename) {
          files[name] = { filename, data: content };
        } else {
          fields[name] = content.toString();
        }
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

/* ═══════════════════════════════════════
   HTTP SERVER
═══════════════════════════════════════ */
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // CORS
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Serve index.html
  if (req.method === 'GET' && url === '/') {
    const html = fs.readFileSync(path.join(__dirname,'index.html'));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    return res.end(html);
  }

  // GET /api/streams
  if (req.method === 'GET' && url === '/api/streams') {
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ streams, total_today: totalToday }));
  }

  // POST /api/streams/start
  if (req.method === 'POST' && url === '/api/streams/start') {
    try {
      const { fields, files } = await parseMultipart(req);
      const { stream_name, source_url, stream_key, quality, fps, audio, delay,
              watermark_enabled, watermark_position, watermark_size, watermark_opacity } = fields;

      if (!stream_name || !source_url || !stream_key) {
        res.writeHead(400,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({error:'البيانات ناقصة'}));
      }
      if (Object.keys(streams).length >= 11) {
        res.writeHead(429,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({error:'وصلت للحد الأقصى من البثوث (11)'}));
      }

      const id = uuid();
      let wmPath = null;

      // Save watermark file
      if (watermark_enabled === 'true' && files.watermark_file) {
        wmPath = `/tmp/wm_${id}_${files.watermark_file.filename}`;
        fs.writeFileSync(wmPath, files.watermark_file.data);
      }

      const info = {
        name:               stream_name,
        source_url,
        stream_key:         '***hidden***',
        quality:            quality || 'copy',
        fps:                fps || '',
        audio:              audio || 'copy',
        watermark:          watermark_enabled === 'true',
        watermark_path:     wmPath,
        watermark_position: watermark_position || 'top_right',
        watermark_size:     watermark_size || 'medium',
        watermark_opacity:  watermark_opacity || '0.8',
        start_time:         Math.floor(Date.now()/1000),
        pid:                null,
      };
      streams[id] = info;
      totalToday++;

      startFFmpeg(id, {
        source_url, stream_key, quality: quality||'copy',
        fps, audio: audio||'copy',
        watermark_enabled: watermark_enabled==='true',
        watermark_path: wmPath,
        watermark_position, watermark_size, watermark_opacity,
      }, parseInt(delay)||0);

      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({success:true, stream_id:id}));
    } catch(e) {
      console.error(e);
      res.writeHead(500,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({error:e.message}));
    }
  }

  // POST /api/streams/:id/stop
  const stopMatch = url.match(/^\/api\/streams\/([^/]+)\/stop$/);
  if (req.method === 'POST' && stopMatch) {
    const id = stopMatch[1];
    if (processes[id]) {
      processes[id].kill('SIGTERM');
      setTimeout(()=>{ if(processes[id]) processes[id].kill('SIGKILL'); }, 5000);
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({success:true}));
    }
    res.writeHead(404,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({error:'البث غير موجود'}));
  }

  // POST /api/streams/:id/restart
  const restartMatch = url.match(/^\/api\/streams\/([^/]+)\/restart$/);
  if (req.method === 'POST' && restartMatch) {
    const id = restartMatch[1];
    const info = streams[id];
    if (!info) {
      res.writeHead(404,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({error:'البث غير موجود'}));
    }
    if (processes[id]) processes[id].kill('SIGTERM');
    streams[id].start_time = Math.floor(Date.now()/1000);
    // restart will be triggered via close event — simple re-spawn:
    setTimeout(()=>{
      if (!processes[id]) {
        startFFmpeg(id, {
          source_url: info.source_url, stream_key: info._key || '',
          quality: info.quality, fps: info.fps, audio: info.audio,
          watermark_enabled: info.watermark, watermark_path: info.watermark_path,
          watermark_position: info.watermark_position, watermark_size: info.watermark_size,
          watermark_opacity: info.watermark_opacity,
        });
      }
    }, 2000);
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({success:true}));
  }

  res.writeHead(404,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:'Not found'}));
});

/* ═══════════════════════════════════════
   WEBSOCKET (manual upgrade, no deps)
═══════════════════════════════════════ */
const crypto = require('crypto');

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11','binary')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  clients.add(socket);
  console.log(`[WS] client connected (${clients.size} total)`);

  // Send current streams on connect
  wsSend(socket, { type:'streams_list', streams });

  socket.on('data', buf => {
    try {
      const msg = wsRead(buf);
      if (!msg) return;
      const data = JSON.parse(msg);
      if (data.type === 'get_streams') wsSend(socket, { type:'streams_list', streams });
    } catch(e) {}
  });

  socket.on('close', () => { clients.delete(socket); });
  socket.on('error', ()  => { clients.delete(socket); });
});

function wsRead(buf) {
  try {
    const second = buf[1] & 0x7F;
    let offset = 2;
    let len = second;
    if (second === 126) { len = buf.readUInt16BE(2); offset = 4; }
    else if (second === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }
    const masked = (buf[1] & 0x80) !== 0;
    let data = buf.slice(offset + (masked ? 4 : 0), offset + (masked ? 4 : 0) + len);
    if (masked) {
      const mask = buf.slice(offset, offset+4);
      for (let i=0;i<data.length;i++) data[i] ^= mask[i%4];
    }
    return data.toString('utf8');
  } catch(e) { return null; }
}

function wsSend(socket, obj) {
  try {
    const str = JSON.stringify(obj);
    const buf = Buffer.from(str,'utf8');
    const frame = buf.length < 126
      ? Buffer.from([0x81, buf.length])
      : buf.length < 65536
        ? Buffer.from([0x81,126,(buf.length>>8)&0xFF,buf.length&0xFF])
        : (() => { const f=Buffer.alloc(10);f[0]=0x81;f[1]=127;f.writeBigUInt64BE(BigInt(buf.length),2);return f; })();
    socket.write(Buffer.concat([frame, buf]));
  } catch(e) {}
}

function broadcast(obj) {
  clients.forEach(s => wsSend(s, obj));
}

/* ═══════════════════════════════════════
   PERIODIC STREAM STATUS BROADCAST
═══════════════════════════════════════ */
setInterval(() => {
  if (clients.size > 0 && Object.keys(streams).length > 0) {
    broadcast({ type:'streams_list', streams });
  }
}, 10000);

/* ═══════════════════════════════════════
   GRACEFUL SHUTDOWN
═══════════════════════════════════════ */
process.on('SIGTERM', () => {
  console.log('Shutting down, killing all streams...');
  Object.keys(processes).forEach(id => {
    try { processes[id].kill('SIGTERM'); } catch(e){}
  });
  process.exit(0);
});

/* ═══════════════════════════════════════
   START
═══════════════════════════════════════ */
server.listen(PORT, () => {
  console.log(`✅ مدير البث يعمل على: http://localhost:${PORT}`);
  console.log(`   FFmpeg مطلوب على نظام التشغيل`);
});
