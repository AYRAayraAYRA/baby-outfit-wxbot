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
  async url(p, maxAge = 900) {
    const fileid = fileIdCache.get(p) || (await this.uploadInfo(p)).file_id;
    const j = await openapi('/tcb/batchdownloadfile', { env: ENV_ID, file_list: [{ fileid, max_age: maxAge }] });
    const f = j.file_list && j.file_list[0];
    return f && f.status === 0 ? f.download_url : null;
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
  async url(p) { return `http://localhost:${PORT}/local/${p}`; },
};

const store = STORAGE === 'local' ? local : cos;

// ---------- 状态 ----------
// sessions: { openid: batchId }
// batches:  { batchId: { openid, status: open|ready|fetched, createdAt, submittedAt, images: [{msgId, createTime, path, ok}], notes: [],
//              stage, preview: {path, text, version}, feedback: [], draftText, error } }
//   stage（只有 owner 的组会自动处理）：previewing → preview_ready →（revise → previewing …）→ approved → producing → draft_ready | failed
// admin:    管理员 openid（能「同意」别人的「申请」）；requests: { openid: {name, at} }
// members:  { openid: 名字 } 授权成员，只有成员的组会自动处理，只有成员能「预览」「ok」「登录」
// login:    { needed, qrPath, updatedAt }  小红书需要扫码登录时由 Mac 上报

let state = null;
let saveChain = Promise.resolve();
const pending = new Map(); // batchId -> Set<Promise>

async function loadState() {
  if (state) return state;
  const buf = await store.get(STATE_PATH);
  state = buf ? JSON.parse(buf.toString()) : { sessions: {}, batches: {} };
  state.login = state.login || { needed: false };
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
  '④ 发「2」结束并提交\n\n想用预览、确认这些功能？发「申请 你的名字」，等管理员通过。';


// ---------- 本人（owner）的流程指令 ----------

const OWNER_HELP =
  '本人指令：\n' +
  '「预览」看九宫格预览\n' +
  '「ok」确认预览，开始出 9 张单套图，并在小红书以「仅自己可见」发布\n' +
  '其他文字＝对预览的修改意见，会重新出预览\n' +
  '「进度」看当前进度\n' +
  '「登录」小红书需要登录时取二维码';
const ADMIN_HELP = '\n\n管理员指令：\n「全部」看所有成员最近的组\n「同意」通过最近一个人的「申请」\n「成员」看成员名单\n（自己没在做的组时，「预览」「进度」看的是最近任何成员的组）';

const STAGE_TEXT = {
  previewing: '正在生成九宫格预览⏳ 大约 3 分钟，好了发「预览」查看',
  preview_ready: '九宫格预览已就绪，发「预览」查看',
  revise: '收到修改意见，正在重新出预览⏳',
  approved: '已确认，排队出单套图⏳',
  producing: '正在出 9 张单套图、拼封面、写文案、填小红书⏳ 大约 15–20 分钟',
  draft_ready: '已在小红书以「仅自己可见」发布✅ 打开小红书 App →「我」→「笔记」检查修改，没问题就在笔记的「权限设置」里改成公开',
  failed: '这一组处理出错了，我在电脑上看一下😣',
};

function isOwner(openid) { return !!(state.members && state.members[openid]); }

const ACTIVE = ['previewing', 'preview_ready', 'revise', 'approved', 'producing'];

// openid 为 null 时不限提交人（只看成员的组）
function latestOwnerBatch(openid) {
  let best = null;
  for (const [id, b] of Object.entries(state.batches)) {
    if (!b.stage || (openid ? b.openid !== openid : !isOwner(b.openid))) continue;
    if (!best || (b.submittedAt || 0) > (best.b.submittedAt || 0)) best = { id, b };
  }
  return best;
}

async function linkTo(p, label) {
  const u = await store.url(p, 900);
  return u ? `<a href="${u}">${label}</a>（15 分钟内有效）` : '（链接生成失败，稍后再试）';
}

async function loginNotice(openid) {
  let pre = '';
  if (openid && openid === state.admin) {
    const reqs = Object.values(state.requests || {}).filter((r) => !r.notified && Date.now() - r.at < 24 * 3600 * 1000);
    if (reqs.length) {
      pre = '📮 新的加入申请：' + reqs.map((r) => r.name).join('、') + '\n发「同意」通过最新的一个。\n\n';
      reqs.forEach((r) => { r.notified = true; });
      saveState();
    }
  }
  // 管理员：其他成员新提的修改意见，下一次发消息时提醒一次
  if (openid && openid === state.admin) {
    for (const bt of Object.values(state.batches)) {
      if (bt.openid === openid || !bt.feedback) continue;
      const fresh = bt.feedback.slice(bt.feedbackSeen || 0);
      if (fresh.length) {
        pre += `📝 ${state.members[bt.openid] || '成员'}对她那组提了修改意见：\n` + fresh.map((f) => `「${f}」`).join('\n') + '\n已自动按意见重新出预览。\n\n';
        bt.feedbackSeen = bt.feedback.length;
        saveState();
      }
    }
  }
  // 草稿存好后，提交这组的人下一次发任何消息都先看到一次提醒
  if (openid) {
    for (const bt of Object.values(state.batches)) {
      if (bt.openid === openid && bt.stage === 'draft_ready' && !bt.draftNotified) {
        const title = (bt.draftText || '').split('\n')[0].trim();
        pre += `✅ 上一组已在小红书以「仅自己可见」发布${title ? `：「${title}」` : ''}\n请及时打开小红书 App →「我」→「笔记」检查修改，没问题就在笔记的「权限设置」里改成公开。\n\n`;
        bt.draftNotified = true;
        saveState();
      }
    }
  }
  return pre + (isOwner(openid) ? await xhsLoginNotice() : '');
}

async function xhsLoginNotice() {
  const L = state.login;
  if (!L || !L.needed || !L.qrPath) return '';
  return '⚠️ 小红书要重新登录：' + (await linkTo(L.qrPath, '点这里看二维码')) +
    '\n长按保存图片 → 小红书 App「扫一扫」→ 从相册选这张图 → 确认登录。二维码约 40 秒刷新一次，过期就重新发「登录」。\n\n';
}

async function handleOwnerText(text, openid) {
  const cur = latestOwnerBatch(openid);
  const t = text.toLowerCase();
  let view = cur;
  if (openid === state.admin && !(cur && ACTIVE.includes(cur.b.stage))) view = latestOwnerBatch(null) || cur;
  const who = view && view.b.openid !== openid ? `【${state.members[view.b.openid] || '成员'}提交的这组】\n` : '';
  if (openid === state.admin && text === '全部') {
    const rows = Object.values(state.batches)
      .filter((b) => b.stage && isOwner(b.openid) && Date.now() - (b.submittedAt || 0) < 7 * 24 * 3600 * 1000)
      .sort((x, y) => (y.submittedAt || 0) - (x.submittedAt || 0)).slice(0, 8)
      .map((b) => `· ${state.members[b.openid] || '成员'}（${((t) => `${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(9, 11)}:${t.slice(11, 13)}`)(bjTime(new Date(b.submittedAt || 0)))}）：${(STAGE_TEXT[b.stage] || b.stage).split(/[，,⏳✅\n]/)[0]}`);
    return rows.length ? '最近 7 天的组：\n' + rows.join('\n') : '最近 7 天没有提交的组。';
  }
  if (text === '登录') {
    return (await loginNotice(openid)) || '现在小红书不需要登录👌';
  }
  if (openid === state.admin && text === '成员') {
    return '成员：\n' + Object.values(state.members || {}).join('\n');
  }
  if (openid === state.admin && text === '同意') {
    const reqs = Object.entries(state.requests || {}).filter(([, r]) => Date.now() - r.at < 24 * 3600 * 1000);
    if (!reqs.length) return '现在没有待通过的申请（申请 24 小时内有效）。';
    const [who, r] = reqs.sort((a, b) => b[1].at - a[1].at)[0];
    state.members[who] = r.name;
    delete state.requests[who];
    saveState();
    return `已通过「${r.name}」✅ 现在成员共 ${Object.keys(state.members).length} 人。`;
  }
  if (text === '进度' || text === '帮助') {
    let s = view ? who + (STAGE_TEXT[view.b.stage] || view.b.stage) : '现在没有在处理的组';
    if (view && view.b.progressText && ['producing', 'previewing', 'revise'].includes(view.b.stage)) {
      const mins = Math.round((Date.now() - (view.b.progressAt || Date.now())) / 60000);
      s += '\n\n' + view.b.progressText + `\n（${mins} 分钟前更新）`;
      if (view.b.progressImage) s += '\n' + (await linkTo(view.b.progressImage, '点这里看已出的图'));
    }
    if (view && view.b.stage === 'failed' && view.b.error) s += '\n原因：' + view.b.error;
    return (await loginNotice(openid)) + s + (text === '帮助' ? '\n\n' + OWNER_HELP + (openid === state.admin ? ADMIN_HELP : '') : '');
  }
  if (text === '预览') {
    if (!view) return '还没有预览。发「1」开始一组衣服图。';
    const b = view.b;
    if (!b.preview) return (await loginNotice(openid)) + who + (STAGE_TEXT[b.stage] || '还没好');
    const mine = view.b.openid === openid;
    const tail = b.stage === 'preview_ready'
      ? (mine ? '满意回「ok」；要改直接说哪里要改（比如"第 8 套裙子是湖蓝色"）。' : '（确认和修改由提交人在她的公众号对话里操作）')
      : (STAGE_TEXT[b.stage] || '');
    const fb = !mine && b.feedback && b.feedback.length ? '\n\n她提过的修改意见：\n' + b.feedback.map((f, i) => `${i + 1}. ${f}`).join('\n') : '';
    return (await loginNotice(openid)) + who + `九宫格预览 v${b.preview.version || 1}👇\n` + (await linkTo(b.preview.path, '点这里看预览图')) +
      '\n\n' + (b.preview.text || '') + fb + '\n\n' + tail;
  }
  if (['ok', '好', '好的', '确认', '可以'].includes(t)) {
    if (!cur || cur.b.stage !== 'preview_ready') return (await loginNotice(openid)) + (cur ? STAGE_TEXT[cur.b.stage] : '现在没有等确认的预览');
    cur.b.stage = 'approved';
    cur.b.approvedAt = Date.now();
    saveState();
    return '好嘞✅ 开始出 9 张单套图 → 拼封面 → 写文案 → 在小红书以「仅自己可见」发布，大约 15 分钟。\n发「进度」随时查看。';
  }
  if (cur && cur.b.stage === 'preview_ready') {
    cur.b.feedback = cur.b.feedback || [];
    cur.b.feedback.push(text);
    cur.b.stage = 'revise';
    saveState();
    return '修改意见记下了📝 正在重新出预览，大约 3 分钟后发「预览」查看。';
  }
  return null; // 交给通用逻辑
}

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
    const CMDS = ['预览', '进度', '帮助', '登录', '成员', '同意', '全部'];
    if (isOwner(openid) && (!batch || CMDS.includes(text))) {
      const r = await handleOwnerText(text, openid);
      if (r) return r;
    }
    if (!isOwner(openid) && text.startsWith('申请')) {
      const name = text.slice(2).trim().slice(0, 20) || `用户${openid.slice(-4)}`;
      state.requests = state.requests || {};
      state.requests[openid] = { name, at: Date.now() };
      saveState();
      return `申请已提交（名字：${name}）📮 等管理员在公众号发「同意」后，你就能用预览、确认这些功能了。`;
    }
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
      const mine = isOwner(openid);
      Promise.allSettled([...(pending.get(id) || [])]).then(() => {
        batch.status = 'ready';
        batch.submittedAt = Date.now();
        if (mine) batch.stage = 'previewing';
        saveState();
      });
      saveState();
      if (mine) return `收到！这一组共 ${n} 张，已提交✅\n正在生成九宫格预览，大约 3 分钟后发「预览」查看。`;
      return `收到！这一组共 ${n} 张，已提交✅ 做好后会发小红书～`;
    }
    if (batch) {
      batch.notes.push(text);
      saveState();
      return '备注记下了📝';
    }
    if (isOwner(openid)) return (await loginNotice(openid)) + OWNER_HELP;
    return (await loginNotice(openid)) + HELP;
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
    if (STORAGE === 'local' && url.pathname.startsWith('/local/')) {
      const buf = await local.get(decodeURIComponent(url.pathname.slice(7)));
      return buf ? send(res, 200, buf, 'image/jpeg') : send(res, 404, { error: 'not found' });
    }

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

      // 成员管理：POST /api/members {openid, name}（name 为空＝移除）；GET /api/members
      if (url.pathname === '/api/members') {
        state.members = state.members || {};
        if (req.method === 'POST') {
          const { openid, name, admin } = JSON.parse((await readBody(req)).toString() || '{}');
          if (!openid) return send(res, 400, { error: 'openid required' });
          if (name) state.members[openid] = name; else delete state.members[openid];
          if (admin) state.admin = openid;
          await saveState();
        }
        return send(res, 200, { members: state.members, admin: state.admin || null, requests: state.requests || {} });
      }

      // Mac 要处理的活：owner 的组里 stage 为 previewing / revise / approved 的
      if (req.method === 'GET' && url.pathname === '/api/work') {
        const list = Object.entries(state.batches)
          .filter(([, b]) => isOwner(b.openid) && ['previewing', 'revise', 'approved'].includes(b.stage))
          .map(([id, b]) => ({ id, openid: b.openid, member: state.members[b.openid], stage: b.stage, feedback: b.feedback || [], notes: b.notes || [], previewVersion: (b.preview && b.preview.version) || 0 }));
        return send(res, 200, { work: list });
      }

      // 更新进度：POST /api/batches/:id/stage {stage, previewText?, draftText?, error?}
      const ms = url.pathname.match(/^\/api\/batches\/([\w-]+)\/stage$/);
      if (req.method === 'POST' && ms) {
        const b = state.batches[ms[1]];
        if (!b) return send(res, 404, { error: 'not found' });
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (body.stage) b.stage = body.stage;
        if (body.previewText != null) { b.preview = b.preview || {}; b.preview.text = body.previewText; }
        if (body.draftText != null) b.draftText = body.draftText;
        if (body.error != null) b.error = body.error;
        if (body.progressText != null) { b.progressText = body.progressText; b.progressAt = Date.now(); }
        await saveState();
        return send(res, 200, { ok: true });
      }

      // 进度缩略图：POST /api/batches/:id/progress-image（body 是 jpg）
      const mg = url.pathname.match(/^\/api\/batches\/([\w-]+)\/progress-image$/);
      if (req.method === 'POST' && mg) {
        const b = state.batches[mg[1]];
        if (!b) return send(res, 404, { error: 'not found' });
        const p = `wxbot/batches/${mg[1]}/progress_${Date.now()}.jpg`;
        await store.put(p, await readBody(req), 'image/jpeg');
        b.progressImage = p;
        await saveState();
        return send(res, 200, { ok: true });
      }

      // 上传预览图：POST /api/batches/:id/preview（body 是 jpg）
      const mp = url.pathname.match(/^\/api\/batches\/([\w-]+)\/preview$/);
      if (req.method === 'POST' && mp) {
        const b = state.batches[mp[1]];
        if (!b) return send(res, 404, { error: 'not found' });
        const version = ((b.preview && b.preview.version) || 0) + 1;
        const p = `wxbot/batches/${mp[1]}/preview_v${version}.jpg`;
        await store.put(p, await readBody(req), 'image/jpeg');
        b.preview = { ...(b.preview || {}), path: p, version };
        await saveState();
        return send(res, 200, { ok: true, version });
      }

      // 小红书登录：POST /api/login {needed}；POST /api/login/qr（body 是二维码截图）
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const { needed } = JSON.parse((await readBody(req)).toString() || '{}');
        state.login = { ...state.login, needed: !!needed, updatedAt: Date.now() };
        if (!needed) delete state.login.qrPath;
        await saveState();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/login/qr') {
        const p = `wxbot/login/qr_${Date.now()}.png`;
        await store.put(p, await readBody(req), 'image/png');
        state.login = { needed: true, qrPath: p, updatedAt: Date.now() };
        await saveState();
        return send(res, 200, { ok: true });
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
