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
    padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 4px;
  }
  .stock-list li[draggable="true"] { cursor: grab; }
  .stock-list li.dragging { opacity: 0.4; border-style: dashed; }
  .stock-list li.drag-over { border-color: var(--accent); background: var(--accent-soft); }
  .stock-code { font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 13px; }
  .stock-name { color: var(--muted); font-size: 13px; }
  .row-actions { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
  .row-actions button { padding: 2px 7px; font-size: 12px; }
  .group-card { cursor: default; }
  .group-card[draggable="true"] { cursor: grab; }
  .group-card.dragging { opacity: 0.4; border-style: dashed; }
  .group-card.drag-over { border-color: var(--accent); }
  .empty { color: var(--muted); font-size: 13px; padding: 6px 2px; }
  .hint-drag { color: var(--muted); font-size: 12px; margin-top: 8px; }
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
    <p class="hint-drag">拖动分组或股票可以调整顺序；顺序会同步到桌面客户端。</p>
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
      var first = i === 0
      var last = i === groups.length - 1
      html += '<div class="card group-card" draggable="true" data-action="group-row" data-id="' + esc(group.id) + '" data-index="' + i + '">'
      html += '<div class="group-head"><div><span class="group-name">' + esc(group.name) + '</span><span class="count">' + group.codes.length + ' 只</span></div>'
      html += '<div class="row-actions">'
      html += '<button class="ghost small" data-action="move-group" data-id="' + esc(group.id) + '" data-dir="-1"' + (first ? ' disabled' : '') + '>↑</button>'
      html += '<button class="ghost small" data-action="move-group" data-id="' + esc(group.id) + '" data-dir="1"' + (last ? ' disabled' : '') + '>↓</button>'
      html += '<button class="danger small" data-action="del-group" data-id="' + esc(group.id) + '">删除分组</button></div></div>'
      html += '<ul class="stock-list">'
      if (group.codes.length === 0) {
        html += '<li class="empty">暂无股票</li>'
      } else {
        for (var j = 0; j < group.codes.length; j++) {
          var code = group.codes[j]
          var name = names[code]
          var codeFirst = j === 0
          var codeLast = j === group.codes.length - 1
          html += '<li draggable="true" data-action="code-row" data-id="' + esc(group.id) + '" data-code="' + esc(code) + '" data-index="' + j + '"><div><span class="stock-code">' + esc(code) + '</span>'
          if (name) html += ' <span class="stock-name">' + esc(name) + '</span>'
          html += '</div><div class="row-actions">'
          html += '<button class="ghost small" data-action="move-code" data-id="' + esc(group.id) + '" data-code="' + esc(code) + '" data-dir="-1"' + (codeFirst ? ' disabled' : '') + '>↑</button>'
          html += '<button class="ghost small" data-action="move-code" data-id="' + esc(group.id) + '" data-code="' + esc(code) + '" data-dir="1"' + (codeLast ? ' disabled' : '') + '>↓</button>'
          html += '<button class="danger small" data-action="del-code" data-id="' + esc(group.id) + '" data-code="' + esc(code) + '">删除</button>'
          html += '</div></li>'
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
    bindDragDrop()
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  var dragFrom = null

  function bindDragDrop() {
    var rows = groupsEl.querySelectorAll('[data-action="group-row"], [data-action="code-row"]')
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener('dragstart', function (event) {
        dragFrom = {
          groupId: this.getAttribute('data-id'),
          code: this.getAttribute('data-code'),
        }
        this.classList.add('dragging')
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', dragFrom.code || dragFrom.groupId)
      })
      rows[i].addEventListener('dragend', function () {
        this.classList.remove('dragging')
        var targets = groupsEl.querySelectorAll('.drag-over')
        for (var j = 0; j < targets.length; j++) targets[j].classList.remove('drag-over')
        dragFrom = null
      })
      rows[i].addEventListener('dragover', function (event) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        this.classList.add('drag-over')
      })
      rows[i].addEventListener('dragleave', function () {
        this.classList.remove('drag-over')
      })
      rows[i].addEventListener('drop', function (event) {
        event.preventDefault()
        this.classList.remove('drag-over')
        if (!dragFrom) return
        var targetGroupId = this.getAttribute('data-id')
        var targetCode = this.getAttribute('data-code')
        // 股票拖拽：仅允许在同一个分组内重排；分组拖拽：整组重排。
        if (dragFrom.code) {
          if (dragFrom.code === targetCode || dragFrom.groupId !== targetGroupId) return
          var group = state.data.groups.find(function (g) { return g.id === dragFrom.groupId })
          if (!group) return
          var from = group.codes.indexOf(dragFrom.code)
          var to = group.codes.indexOf(targetCode)
          if (from < 0 || to < 0) return
          group.codes.splice(from, 1)
          group.codes.splice(to, 0, dragFrom.code)
        } else {
          if (dragFrom.groupId === targetGroupId) return
          var groups = state.data.groups
          var fromGroup = groups.findIndex(function (g) { return g.id === dragFrom.groupId })
          var toGroup = groups.findIndex(function (g) { return g.id === targetGroupId })
          if (fromGroup < 0 || toGroup < 0) return
          var moved = groups.splice(fromGroup, 1)[0]
          groups.splice(toGroup, 0, moved)
        }
        persistOrder()
      })
    }
  }

  function findGroup(groupId) {
    return (state.data.groups || []).find(function (g) { return g.id === groupId })
  }

  function moveGroup(groupId, direction) {
    var groups = state.data.groups
    var index = groups.findIndex(function (g) { return g.id === groupId })
    var target = index + direction
    if (index < 0 || target < 0 || target >= groups.length) return
    var moved = groups.splice(index, 1)[0]
    groups.splice(target, 0, moved)
    persistOrder()
  }

  function moveCode(groupId, code, direction) {
    var group = findGroup(groupId)
    if (!group) return
    var index = group.codes.indexOf(code)
    var target = index + direction
    if (index < 0 || target < 0 || target >= group.codes.length) return
    group.codes.splice(index, 1)
    group.codes.splice(target, 0, code)
    persistOrder()
  }

  function persistOrder() {
    render()
    api('POST', '/v1/watchlist/replace', { groups: state.data.groups })
      .then(function () { setMsg('顺序已保存', true) })
      .catch(function (error) { setMsg('保存顺序失败：' + error.message, false) })
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
      } else if (action === 'move-group') {
        var groupDirection = Number(button.getAttribute('data-dir') || 0)
        moveGroup(id, groupDirection)
        return
      } else if (action === 'move-code') {
        var codeDirection = Number(button.getAttribute('data-dir') || 0)
        moveCode(id, code, codeDirection)
        return
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
