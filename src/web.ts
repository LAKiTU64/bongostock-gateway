/**
 * Static HTML for the watchlist management page. Served at GET /watchlist
 * without authentication; every data call behind it uses the same Bearer
 * token as the desktop client.
 */
export function renderWatchlistPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BongoStock 自选管理</title>
<style>
  :root {
    --bg: #f5f6f8;
    --card: #ffffff;
    --border: #e2e5ea;
    --text: #1f2329;
    --muted: #8a919f;
    --accent: #185fa5;
    --accent-soft: #e6f1fb;
    --danger: #a32d2d;
    --danger-soft: #fcebeb;
    --radius: 10px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
    background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.6;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px; margin-bottom: 14px;
  }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  input[type=text], input[type=password] {
    flex: 1; min-width: 160px; padding: 7px 10px; font-size: 14px;
    border: 1px solid var(--border); border-radius: 8px; outline: none;
  }
  input:focus { border-color: var(--accent); }
  button {
    padding: 7px 14px; font-size: 13px; border: none; border-radius: 8px; cursor: pointer;
    background: var(--accent); color: #fff; white-space: nowrap;
  }
  button:hover { opacity: 0.9; }
  button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  button.danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
  button.small { padding: 3px 9px; font-size: 12px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .msg { font-size: 13px; min-height: 20px; margin: 6px 0 0; }
  .msg.ok { color: #0f6e56; }
  .msg.err { color: var(--danger); }
  .group-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .group-name { font-size: 15px; font-weight: 600; }
  .count { color: var(--muted); font-size: 12px; font-weight: 400; margin-left: 6px; }
  .stock-list { list-style: none; }
  .stock-list li {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 6px;
  }
  .stock-code { font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 13px; }
  .stock-name { color: var(--muted); font-size: 13px; }
  .empty { color: var(--muted); font-size: 13px; padding: 6px 2px; }
  .add-stock { margin-top: 10px; }
  .candidates { margin-top: 8px; }
  .candidate {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--bg); margin-bottom: 4px; cursor: pointer;
  }
  .candidate:hover { border-color: var(--accent); }
  .candidate .hint { color: var(--muted); font-size: 12px; margin-left: 6px; }
  .tag {
    display: inline-block; background: var(--accent-soft); color: var(--accent);
    border-radius: 6px; padding: 1px 8px; font-size: 12px; margin-right: 6px;
  }
  .toolbar { margin-bottom: 14px; }
  .hidden { display: none; }
  .loading { color: var(--muted); font-size: 13px; padding: 20px 0; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>BongoStock 自选管理</h1>
  <div class="sub">与桌面客户端共用同一个 Bearer Token · 数据保存在云端网关</div>

  <div class="card toolbar">
    <div class="row">
      <input type="password" id="token" placeholder="输入 Bearer Token（与客户端相同）" autocomplete="off">
      <button id="connect">连接</button>
    </div>
    <p class="msg" id="authMsg"></p>
  </div>

  <div id="app" class="hidden">
    <div class="card" style="display:flex;gap:8px;align-items:center">
      <input type="text" id="newGroupName" placeholder="新分组名称" maxlength="20">
      <button id="addGroup" class="ghost">新建分组</button>
      <button id="refresh" class="ghost" style="margin-left:auto">刷新</button>
    </div>
    <div id="groups"></div>
  </div>
</div>

<script>
(function () {
  var state = { token: '', data: null }
  var tokenInput = document.getElementById('token')
  var app = document.getElementById('app')
  var groupsEl = document.getElementById('groups')
  var msgEl = document.getElementById('authMsg')

  var saved = null
  try { saved = localStorage.getItem('bongostock.watchlist.token') } catch (e) { /* ignore */ }
  if (saved) tokenInput.value = saved

  function setMsg(text, ok) {
    msgEl.textContent = text || ''
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err')
  }

  async function api(method, path, body) {
    var response = await fetch(path, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + state.token
      },
      body: body ? JSON.stringify(body) : undefined
    })
    var payload = null
    var text = await response.text()
    try { payload = JSON.parse(text) } catch (e) { /* non-json */ }
    if (!response.ok) {
      var message = (payload && payload.error) || ('HTTP ' + response.status)
      throw new Error(message)
    }
    return payload
  }

  async function load() {
    setMsg('加载中…', true)
    try {
      var data = await api('GET', '/v1/watchlist')
      state.data = data
      render()
      setMsg('', true)
    } catch (error) {
      setMsg('加载失败：' + error.message, false)
      if (/401|unauthorized/.test(String(error.message))) state.data = null
    }
  }

  function render() {
    if (!state.data) return
    var groups = state.data.groups || []
    var names = state.data.names || {}
    var html = ''
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i]
      html += '<div class="card"><div class="group-head"><div><span class="group-name">' + esc(group.name) + '</span><span class="count">' + group.codes.length + ' 只</span></div>'
      html += '<button class="danger small" data-action="del-group" data-id="' + esc(group.id) + '">删除分组</button></div>'
      html += '<ul class="stock-list">'
      if (group.codes.length === 0) {
        html += '<li class="empty">暂无股票</li>'
      } else {
        for (var j = 0; j < group.codes.length; j++) {
          var code = group.codes[j]
          var name = names[code]
          html += '<li><div><span class="stock-code">' + esc(code) + '</span>'
          if (name) html += ' <span class="stock-name">' + esc(name) + '</span>'
          html += '</div><button class="danger small" data-action="del-code" data-id="' + esc(group.id) + '" data-code="' + esc(code) + '">删除</button></li>'
        }
      }
      html += '</ul>'
      html += '<div class="add-stock">'
      html += '<div class="row"><input type="text" data-action="code-input" data-id="' + esc(group.id) + '" placeholder="输入 6 位代码或名称，如 000001 / 平安 / SH600519" maxlength="32"><button class="ghost small" data-action="search-code" data-id="' + esc(group.id) + '">搜索</button></div>'
      html += '<div class="candidates" data-candidates="' + esc(group.id) + '"></div>'
      html += '</div>'
      html += '</div>'
    }
    if (groups.length === 0) {
      html = '<div class="card empty">还没有分组，先在上方新建一个。</div>'
    }
    groupsEl.innerHTML = html
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function inputFor(element) {
    var container = element.closest ? element.closest('.card') : null
    if (!container) return null
    return container.querySelector('input[data-action="code-input"]')
  }

  function candidatesFor(groupId) {
    return document.querySelector('[data-candidates="' + groupId + '"]')
  }

  // 与客户端 searchSecurityCandidates 一致：6 位纯数字精确匹配后 6 位，
  // 带 SH/SZ 前缀精确匹配，其余按名称/代码模糊匹配。
  function filterCandidates(candidates, query) {
    var q = query.trim().toUpperCase()
    if (/^(?:SH|SZ)\d{6}$/.test(q)) {
      return candidates.filter(function (c) { return c.code.toUpperCase() === q })
    }
    if (/^\d{6}$/.test(q)) {
      return candidates.filter(function (c) { return /^(?:SH|SZ)\d{6}$/.test(c.code) && c.code.slice(2) === q })
    }
    return candidates
  }

  async function searchCode(groupId, query) {
    var candidates = candidatesFor(groupId)
    if (!candidates) return
    var value = (query ?? '').trim()
    if (!value) { setMsg('请输入 6 位代码或名称', false); return }
    candidates.innerHTML = ''
    try {
      var payload = await api('POST', '/v1/search', { query: value })
      var rows = (payload && Array.isArray(payload.candidates)) ? payload.candidates : []
      var matches = filterCandidates(rows, value)
      if (matches.length === 0) {
        candidates.innerHTML = '<div class="candidate"><span class="stock-name">没有找到匹配的证券</span></div>'
        return
      }
      if (matches.length === 1) {
        await addCandidate(groupId, matches[0])
        return
      }
      var html = ''
      for (var i = 0; i < matches.length; i++) {
        var c = matches[i]
        html += '<div class="candidate" data-action="pick-candidate" data-id="' + esc(groupId) + '" data-code="' + esc(c.code) + '" data-name="' + esc(c.name || '') + '">'
        html += '<div><span class="stock-code">' + esc(c.code) + '</span><span class="hint">' + esc(c.name || '') + '</span></div>'
        html += '<span class="tag">添加</span></div>'
      }
      candidates.innerHTML = html
    } catch (error) {
      candidates.innerHTML = '<div class="candidate"><span class="stock-name">搜索失败：' + esc(error.message) + '</span></div>'
    }
  }

  async function addCandidate(groupId, candidate) {
    var candidates = candidatesFor(groupId)
    try {
      await api('POST', '/v1/watchlist/groups/' + encodeURIComponent(groupId) + '/codes', { code: candidate.code })
      if (candidates) candidates.innerHTML = ''
      var input = document.querySelector('input[data-action="code-input"][data-id="' + groupId + '"]')
      if (input) input.value = ''
      await load()
    } catch (error) {
      setMsg('添加失败：' + error.message, false)
    }
  }

  document.getElementById('connect').addEventListener('click', async function () {
    var token = tokenInput.value.trim()
    if (!token) { setMsg('请输入 Token', false); return }
    state.token = token
    try { localStorage.setItem('bongostock.watchlist.token', token) } catch (e) { /* ignore */ }
    app.classList.remove('hidden')
    await load()
  })

  document.getElementById('addGroup').addEventListener('click', async function () {
    var input = document.getElementById('newGroupName')
    var name = input.value.trim()
    if (!name) { setMsg('请输入分组名称', false); return }
    try {
      await api('POST', '/v1/watchlist/groups', { name: name })
      input.value = ''
      await load()
    } catch (error) { setMsg('新建分组失败：' + error.message, false) }
  })

  document.getElementById('refresh').addEventListener('click', load)

  groupsEl.addEventListener('click', async function (event) {
    var button = event.target.closest('button[data-action], [data-action="pick-candidate"]')
    if (!button) return
    var action = button.getAttribute('data-action')
    var id = button.getAttribute('data-id')
    var code = button.getAttribute('data-code')
    var name = button.getAttribute('data-name')
    try {
      if (action === 'del-group') {
        if (!confirm('确定删除该分组？')) return
        await api('DELETE', '/v1/watchlist/groups/' + encodeURIComponent(id))
      } else if (action === 'del-code') {
        await api('DELETE', '/v1/watchlist/groups/' + encodeURIComponent(id) + '/codes/' + encodeURIComponent(code))
      } else if (action === 'search-code') {
        var input = inputFor(button)
        await searchCode(id, input ? input.value : '')
        return
      } else if (action === 'pick-candidate') {
        await addCandidate(id, { code: code, name: name || '' })
        return
      }
      await load()
    } catch (error) { setMsg('操作失败：' + error.message, false) }
  })

  groupsEl.addEventListener('keydown', async function (event) {
    if (event.key !== 'Enter') return
    var input = event.target.closest('input[data-action="code-input"]')
    if (!input) return
    var id = input.getAttribute('data-id')
    await searchCode(id, input.value)
  })

  if (saved) {
    state.token = saved
    app.classList.remove('hidden')
    load()
  }
})()
</script>
</body>
</html>`
}
