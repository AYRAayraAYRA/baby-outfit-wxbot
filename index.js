// 公众号收图服务（微信云托管）
// 发「1」开始一组，发图片逐张收下，发「2」结束并提交；Mac 上的 sync.py 定时拉取已提交的组。
// 无第三方依赖，Node 18+。

const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const PORT = process.env.PORT || 80;
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const STORAGE = process.env.STORAGE || 'cos'; // cos | local（本地测试用）
const LOCAL_DIR = process.env.LOCAL_DIR || './data';
const ENV_ID = process.env.CBR_ENV_ID || process.env.ENV_ID || '';
const OPENAPI = process.env.OPENAPI_BASE || 'http://api.weixin.qq.com'; // 云托管开放接口服务，免 access_token
const MAX_IMAGES = 20;
const STATE_PATH = 'wxbot/state.json';

// ---------- 存储 ----------

const fileIdCache = new Map();

async function openapi(p, body) {
  const r = await fetch(OPENAPI + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.errcode) throw new Error(`${p} errcode=${j.errcode} ${j.errmsg}`);
  return j;
}

const cos = {
  async uploadInfo(p) {
    const j = await openapi('/tcb/uploadfile', { env: ENV_ID, path: p });
    fileIdCache.set(p, j.file_id);
    return j;
  },
  async put(p, buf, type) {
    const j = await this.uploadInfo(p);
    const form = new FormData();
    form.append('key', p);
    form.append('Signature', j.authorization);
    form.append('x-cos-security-token', j.token);
    form.append('x-cos-meta-fileid', j.cos_file_id);
    form.append('file', new Blob([buf], { type: type || 'application/octet-stream' }));
    const r = await fetch(j.url, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`COS 上传失败 ${r.status} ${await r.text()}`);
  },
  async get(p) {
    // uploadfile 只拿凭证不传文件，借它得到 file_id
    const fileid = fileIdCache.get(p) || (await this.uploadInfo(p)).file_id;
    const j = await openapi('/tcb/batchdownloadfile', {
      env: ENV_ID,
      file_list: [{ fileid, max_age: 600 }],
    });
    const f = j.file_list && j.file_list[0];
    if (!f || f.status !== 0 || !f.download_url) return null;
    const r = await fetch(f.download_url);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`COS 下载失败 ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  },
};

const local = {
  async put(p, buf) {
    const full = path.join(LOCAL_DIR, p);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buf);
  },
  async get(p) {
    try { return await fs.readFile(path.join(LOCAL_DIR, p)); } catch { return null; }
  },
};

const store = STORAGE === 'local' ? local : cos;

// ---------- 状态 ----------
// sessions: { openid: batchId }
// batches:  { batchId: { openid, status: open|ready|fetched, createdAt, submittedAt, images: [{msgId, createTime, path, ok}], notes: [] } }

let state = null;
let saveChain = Promise.resolve();
const pending = new Map(); // batchId -> Set<Promise>

async function loadState() {
  if (state) return state;
  const buf = await store.get(STATE_PATH);
  state = buf ? JSON.parse(buf.toString()) : { sessions: {}, batches: {} };
  return state;
}

function saveState() {
  const snapshot = JSON.stringify(state, null, 1);
  saveChain = saveChain
    .then(() => store.put(STATE_PATH, Buffer.from(snapshot), 'application/json'))
    .catch((e) => console.error('保存状态失败', e));
  return saveChain;
}

function bjTime(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000).toISOString();
  return t.slice(0, 10).replace(/-/g, '') + '-' + t.slice(11, 19).replace(/:/g, '');
}

function track(batchId, p) {
  if (!pending.has(batchId)) pending.set(batchId, new Set());
  const set = pending.get(batchId);
  set.add(p);
  p.finally(() => set.delete(p));
}

// ---------- 消息处理 ----------

const HELP =
  '你好～这里收宝宝穿搭的衣服图👗\n' +
  '① 发「1」开始一组\n' +
  '② 按顺序发衣服图片（一套一张，一般 9 张）\n' +
  '③ 想补充说明可以直接发文字\n' +
  '④ 发「2」结束并提交';

function startBatch(openid) {
  const id = `${bjTime()}-${openid.slice(-6)}`;
  state.batches[id] = { openid, status: 'open', createdAt: Date.now(), images: [], notes: [] };
  state.sessions[openid] = id;
  return id;
}

async function handle(msg) {
  await loadState();
  const openid = msg.FromUserName;
  const type = msg.MsgType;
  let batchId = state.sessions[openid];
  let batch = batchId && state.batches[batchId];

  if (type === 'event') {
    return msg.Event === 'subscribe' ? HELP : null;
  }

  if (type === 'text') {
    const text = String(msg.Content || '').trim();
    if (text === '1') {
      if (batch && batch.images.length) {
        return `你还有一组没提交（已收 ${batch.images.length} 张）。发「2」先提交，或者继续发图接着这组。`;
      }
      if (!batch) { startBatch(openid); saveState(); }
      return '好的，开始新的一组📸 请按顺序发衣服图片，发完了发「2」。';
    }
    if (text === '2') {
      if (!batch) return '现在没有进行中的一组。发「1」开始。';
      if (!batch.images.length) return '这一组还没有图片哦，发完图再发「2」。';
      delete state.sessions[openid];
      const n = batch.images.length;
      const id = batchId;
      // 等这一组的图都传完再标记为可拉取
      Promise.allSettled([...(pending.get(id) || [])]).then(() => {
        batch.status = 'ready';
        batch.submittedAt = Date.now();
        saveState();
      });
      saveState();
      return `收到！这一组共 ${n} 张，已提交✅ 做好后会发小红书～`;
    }
    if (batch) {
      batch.notes.push(text);
      saveState();
      return '备注记下了📝';
    }
    return HELP;
  }

  if (type === 'image') {
    let auto = false;
    if (!batch) { batchId = startBatch(openid); batch = state.batches[batchId]; auto = true; }
    const msgId = String(msg.MsgId);
    if (batch.images.some((im) => im.msgId === msgId)) return null; // 微信重试
    if (batch.images.length >= MAX_IMAGES) return `一组最多 ${MAX_IMAGES} 张，发「2」先提交这一组吧。`;
    const n = batch.images.length + 1;
    const im = { msgId, createTime: Number(msg.CreateTime) || 0, path: `wxbot/batches/${batchId}/${msgId}.jpg`, ok: false };
    batch.images.push(im);
    const job = (async () => {
      const r = await fetch(msg.PicUrl);
      if (!r.ok) throw new Error(`下载图片失败 ${r.status}`);
      await store.put(im.path, Buffer.from(await r.arrayBuffer()), 'image/jpeg');
      im.ok = true;
      saveState();
    })().catch((e) => { im.error = String(e.message || e); console.error(e); saveState(); });
    track(batchId, job);
    return (auto ? '已自动开始新的一组。' : '') + `收到第 ${n} 张✅`;
  }

  return '目前只收图片和文字哦。\n\n' + HELP;
}

// ---------- HTTP ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, code, body, type = 'application/json') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'content-type': type, 'content-length': data.length });
  res.end(data);
}

function authed(req) {
  return SYNC_TOKEN && req.headers['x-sync-token'] === SYNC_TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // 云托管消息推送（JSON 格式）
    if (req.method === 'POST' && url.pathname === '/wx/message') {
      const msg = JSON.parse((await readBody(req)).toString() || '{}');
      if (msg.action === 'CheckContainerPath') return send(res, 200, 'success', 'text/plain');
      const reply = await handle(msg);
      if (!reply) return send(res, 200, 'success', 'text/plain');
      return send(res, 200, {
        ToUserName: msg.FromUserName,
        FromUserName: msg.ToUserName,
        CreateTime: Math.floor(Date.now() / 1000),
        MsgType: 'text',
        Content: reply,
      });
    }

    if (url.pathname === '/health') return send(res, 200, { ok: true });

    // ---- Mac 同步用 ----
    if (url.pathname.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
      await loadState();

      if (req.method === 'GET' && url.pathname === '/api/batches') {
        const status = url.searchParams.get('status') || 'ready';
        const list = Object.entries(state.batches)
          .filter(([, b]) => b.status === status)
          .map(([id, b]) => ({ id, ...b }));
        return send(res, 200, { batches: list });
      }

      if (req.method === 'GET' && url.pathname === '/api/file') {
        const p = url.searchParams.get('path') || '';
        if (!p.startsWith('wxbot/batches/')) return send(res, 400, { error: 'bad path' });
        const buf = await store.get(p);
        if (!buf) return send(res, 404, { error: 'not found' });
        return send(res, 200, buf, 'image/jpeg');
      }

      const m = url.pathname.match(/^\/api\/batches\/([\w-]+)\/ack$/);
      if (req.method === 'POST' && m) {
        const b = state.batches[m[1]];
        if (!b) return send(res, 404, { error: 'not found' });
        b.status = 'fetched';
        b.fetchedAt = Date.now();
        await saveState();
        return send(res, 200, { ok: true });
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    // 给微信回 success，避免它反复重试
    if (url.pathname === '/wx/message') return send(res, 200, 'success', 'text/plain');
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`listening on ${PORT}, storage=${STORAGE}`));
