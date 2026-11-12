/**
 * dsh-session-tabs — browser half (client plugin bundle).
 *
 * Loaded by dsh-client-modules as the package client bundle (@lihengxi20/dsh-tabs) and run
 * through the vendored Loader's lazy-CJS module table
 * (window.__ModuleLoader__.load). Plain CJS, exactly the shape the shipped
 * ui-* bundles emit: `require("react")` / `require("react-dom")` resolve
 * against the shell's platform module table.
 *
 * What it does:
 *   - fills the conversation header's empty `conversation.header.leading` slot
 *     with the current session's workspace folder + name (the active-session
 *     info row);
 *   - appends one grid row to the conversation <header> and portals a session
 *     tab strip into it (one tab per opened session, active one highlighted);
 *   - tracks "opened sessions" across navigations, persists the tab list and
 *     the active tab in localStorage, and switches sessions through
 *     ctx.uiWorkspace.openSession(id).
 *
 * The tab strip is a navigation affordance, not a second renderer: DSH still
 * renders exactly one session at a time, and closing a tab never archives the
 * session, cancels its turn, or stops background work.
 */
(function (root) {
  "use strict";
  if (!root || !root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== "function") return;

  root.__ModuleLoader__.load({
    id: "@lihengxi20/dsh-tabs",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      var React = null;
      try { React = require("react") || null; } catch (e) { React = null; }
      var ReactDOM = null;
      try { ReactDOM = require("react-dom") || null; } catch (e) { ReactDOM = null; }
      var h = React.createElement;

      // ─────────────────────────────────────────────────────────────────────
      // constants
      // ─────────────────────────────────────────────────────────────────────
      var NS = "dsh-session-tabs";
      var LS_KEY = "dsh-session-tabs.v1";
      var STYLE_ID = "dsh-session-tabs-style";
      var MAX_TABS = 50;

      var inject = ["sessions", "slots", "locale"];

      var UI = {
        zh: {
          "tabs.aria": "会话标签",
          "newSession": "新会话",
          "untitled": "未命名",
          "close": "关闭标签（不停止任务）",
          "workspace": "工作区",
          "menu.rename": "重命名",
          "menu.close": "关闭",
          "menu.closeOthers": "关闭其他",
          "menu.closeAll": "全部关闭",
          "rename.title": "重命名会话",
          "rename.placeholder": "输入会话标题",
          "rename.cancel": "取消",
          "rename.save": "保存",
          "rename.empty": "标题不能为空",
          "rename.failed": "重命名失败"
        },
        en: {
          "tabs.aria": "Session tabs",
          "newSession": "New Session",
          "untitled": "Untitled",
          "close": "Close tab (does not stop the task)",
          "workspace": "Workspace",
          "menu.rename": "Rename",
          "menu.close": "Close",
          "menu.closeOthers": "Close Others",
          "menu.closeAll": "Close All",
          "rename.title": "Rename session",
          "rename.placeholder": "Session title",
          "rename.cancel": "Cancel",
          "rename.save": "Save",
          "rename.empty": "Title cannot be empty",
          "rename.failed": "Rename failed"
        }
      };

      // ─────────────────────────────────────────────────────────────────────
      // tiny store (React useSyncExternalStore)
      // ─────────────────────────────────────────────────────────────────────
      var state = {
        tabs: [],        // session ids, opening order
        titles: {},      // sessionId -> last known durable title
        wsTitles: {},    // sessionId -> workspace display title
        currentId: null, // the session the header is actually showing
        active: null,    // last current session (survives list churn)
        probeId: null,   // strict-header probe's session id
        selectionId: null, // uiWorkspace.selection session id
        list: null,      // latest sessions list snapshot
        statuses: null,  // latest sessionStatus Map snapshot
        ready: false,
        uiBound: false,  // sessionStatus source bound
        closed: null,    // {id, at}: just-closed tab that must not resurrect
        clearGuardUntil: 0 // suppress list-derived current after "close all"
      };
      var listeners = new Set();

      function getState() { return state; }
      function subscribe(fn) {
        listeners.add(fn);
        return function () { listeners.delete(fn); };
      }
      function emit() {
        Array.from(listeners).forEach(function (fn) {
          try { fn(); } catch (e) { /* one consumer must not break the rest */ }
        });
      }

      var lastPersisted = null;
      function persist() {
        try {
          var payload = JSON.stringify({ tabs: state.tabs, titles: state.titles, wsTitles: state.wsTitles, active: state.active });
          if (payload === lastPersisted) return;
          root.localStorage.setItem(LS_KEY, payload);
          lastPersisted = payload;
        } catch (e) { /* private mode / quota — tabs still work for this page */ }
      }

      function loadPersisted() {
        try {
          var raw = root.localStorage.getItem(LS_KEY);
          if (raw === null) return;
          var parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object") return;
          var tabs = Array.isArray(parsed.tabs)
            ? parsed.tabs.filter(function (id) { return typeof id === "string" && id.length > 0; }).slice(0, MAX_TABS)
            : [];
          var titles = {};
          if (parsed.titles && typeof parsed.titles === "object") {
            Object.keys(parsed.titles).forEach(function (id) {
              var value = parsed.titles[id];
              if (typeof value === "string") titles[id] = value;
            });
          }
          var wsTitles = {};
          if (parsed.wsTitles && typeof parsed.wsTitles === "object") {
            Object.keys(parsed.wsTitles).forEach(function (id) {
              var value = parsed.wsTitles[id];
              if (typeof value === "string") wsTitles[id] = value;
            });
          }
          state = Object.assign({}, state, {
            tabs: tabs,
            titles: titles,
            wsTitles: wsTitles,
            active: typeof parsed.active === "string" ? parsed.active : null
          });
        } catch (e) { /* ignore malformed storage */ }
      }

      // ─────────────────────────────────────────────────────────────────────
      // session list helpers
      // ─────────────────────────────────────────────────────────────────────
      function currentSessionId(list) {
        if (!list || !Array.isArray(list.ids)) return null;
        for (var i = 0; i < list.ids.length; i++) {
          var id = list.ids[i];
          var row = list.byId ? list.byId[id] : undefined;
          if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id;
        }
        return null;
      }

      function rowTitle(row) {
        if (!row) return "";
        if (typeof row.title === "string" && row.title.trim() !== "") return row.title.trim();
        if (typeof row.displayTitle === "string" && row.displayTitle.trim() !== "") return row.displayTitle.trim();
        return "";
      }

      function syncFromList(list) {
        if (!list) return;
        var tabs = state.tabs.slice();
        var titles = Object.assign({}, state.titles);
        var changed = false;
        // The header's own current session comes from uiSession's main binding;
        // the list's retainedBy is only a fallback for the first paint. After
        // "close all" it stays suppressed until the cleared main view settles.
        var guardingClear = state.clearGuardUntil > Date.now();
        var current = state.currentId || (guardingClear ? null : currentSessionId(list));
        var byId = list.byId || {};
        var ids = Array.isArray(list.ids) ? list.ids : [];
        var ready = list.phase !== "pending" && ids.length > 0;

        // Refresh cached titles (tab labels survive a reload before the list
        // finishes loading, because they are persisted).
        for (var t = 0; t < tabs.length; t++) {
          var row = byId[tabs[t]];
          if (row) {
            var title = rowTitle(row);
            if (title && titles[tabs[t]] !== title) {
              titles[tabs[t]] = title;
              changed = true;
            }
          }
        }

        // Prune tabs whose session vanished (deleted / archived away / no
        // longer catalogued). Never prune the currently open session.
        if (ready) {
          var kept = tabs.filter(function (id) {
            return id === current || Object.prototype.hasOwnProperty.call(byId, id);
          });
          if (kept.length !== tabs.length) { tabs = kept; changed = true; }
        }

        // Opening a session (sidebar / search / new session / tab click) adds
        // it. The current session is always present, so even the first session
        // of a fresh window gets exactly one tab.
        if (current && tabs.indexOf(current) < 0 && !isSuppressed(current)) {
          tabs.push(current);
          if (tabs.length > MAX_TABS) tabs = tabs.slice(tabs.length - MAX_TABS);
          changed = true;
        }

        var active = current || state.active || (tabs.length > 0 ? tabs[tabs.length - 1] : null);
        if (active !== state.active) changed = true;

        state = Object.assign({}, state, {
          list: list,
          tabs: tabs,
          titles: titles,
          active: active,
          ready: state.ready || ready
        });
        if (changed) persist();
        emit();
      }

      function syncFromStatuses(statuses) {
        state = Object.assign({}, state, { statuses: statuses });
        emit();
      }

      /** Workspace display title for a session: live snapshot, then cached, then cwd basename. */
      function workspaceTitleFor(store, id, row) {
        if (id && store.wsTitles && typeof store.wsTitles[id] === "string" && store.wsTitles[id] !== "") {
          return store.wsTitles[id];
        }
        var cwd = row && typeof row.cwd === "string" ? row.cwd : "";
        return basename(cwd);
      }

      function syncFromWorkspaces(snapshot) {
        if (!snapshot) return;
        var items = Array.isArray(snapshot.items) ? snapshot.items : [];
        var changed = false;
        var wsTitles = state.wsTitles;
        // Ignore the empty pre-ready snapshot so cached labels do not flash away.
        if (items.length > 0 || snapshot.phase === "ready") {
          var next = {};
          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item || !Array.isArray(item.sessionIds)) continue;
            var title = typeof item.title === "string" ? item.title.trim() : "";
            if (title === "") continue;
            for (var j = 0; j < item.sessionIds.length; j++) next[item.sessionIds[j]] = title;
          }
          if (JSON.stringify(next) !== JSON.stringify(wsTitles)) {
            wsTitles = next;
            changed = true;
          }
        }
        state = Object.assign({}, state, { wsTitles: wsTitles });
        if (changed) persist();
        emit();
      }

      /**
       * Two authoritative navigation signals, in order:
       *   - `uiWorkspace.selection` (set synchronously by replaceMain, also
       *     covers blank Sessions whose strict header hides the actions slot);
       *   - the strict Session header probe (exact session id the shell renders).
       * The catalog's retainedBy projection is only the last fallback: it lags
       * behind navigation while old main-view references drain.
       */
      function isSuppressed(id) {
        return state.closed !== null && state.closed.id === id && Date.now() - state.closed.at < 2000;
      }

      function applyCurrentId(id) {
        var tabs = state.tabs.slice();
        var titles = Object.assign({}, state.titles);
        if (id && tabs.indexOf(id) < 0 && !isSuppressed(id)) {
          tabs.push(id);
          if (tabs.length > MAX_TABS) tabs = tabs.slice(tabs.length - MAX_TABS);
        }
        state = Object.assign({}, state, {
          currentId: id,
          active: id || state.active,
          tabs: tabs,
          titles: titles
        });
        persist();
        emit();
      }

      function syncSelection(selection) {
        var id = selection && typeof selection.sessionId === "string" ? selection.sessionId : null;
        state = Object.assign({}, state, { selectionId: id });
        if (id !== null) applyCurrentId(id);
        else emit();
      }

      function setProbeId(id) {
        state = Object.assign({}, state, { probeId: id });
        applyCurrentId(state.selectionId || id);
      }

      function clearProbeId(id) {
        if (state.probeId !== id) return;
        state = Object.assign({}, state, { probeId: null });
        // Never fall back to the catalog's retainedBy here: it lags behind
        // navigation and would re-create a tab the user just closed.
        if (state.selectionId !== null) applyCurrentId(state.selectionId);
        else emit();
      }

      // ─────────────────────────────────────────────────────────────────────
      // actions
      // ─────────────────────────────────────────────────────────────────────
      function openSession(ctx, id) {
        if (!id) return;
        try {
          var uiWorkspace = ctx.get("uiWorkspace");
          if (uiWorkspace && typeof uiWorkspace.openSession === "function") {
            uiWorkspace.openSession(id);
          }
        } catch (e) {
          try { console.warn("[dsh-session-tabs] openSession failed", e); } catch (e2) { /* ignore */ }
        }
      }

      function closeTab(ctx, id) {
        var idx = state.tabs.indexOf(id);
        if (idx < 0) return;
        // Closing the last remaining tab behaves like "close all": the tab row
        // disappears and the main view returns to the unselected-session page.
        if (state.tabs.length <= 1) {
          closeAllTabs(ctx);
          return;
        }
        var tabs = state.tabs.slice();
        tabs.splice(idx, 1);
        var titles = Object.assign({}, state.titles);
        delete titles[id];
        var wasCurrent = (state.currentId || currentSessionId(state.list)) === id;
        var nextActive = tabs[Math.min(idx, tabs.length - 1)] || null;
        state = Object.assign({}, state, {
          tabs: tabs,
          titles: titles,
          active: nextActive,
          closed: { id: id, at: Date.now() }
        });
        persist();
        emit();
        if (wasCurrent && nextActive) openSession(ctx, nextActive);
      }

      function closeOtherTabs(ctx, keepId) {
        if (state.tabs.length <= 1 || state.tabs.indexOf(keepId) < 0) return;
        openSession(ctx, keepId);
        var titles = {};
        if (state.titles[keepId]) titles[keepId] = state.titles[keepId];
        state = Object.assign({}, state, {
          tabs: [keepId],
          titles: titles,
          active: keepId,
          currentId: keepId,
          closed: null
        });
        persist();
        emit();
      }

      function closeAllTabs(ctx) {
        if (state.tabs.length === 0) return;
        state = Object.assign({}, state, {
          tabs: [],
          titles: {},
          active: null,
          currentId: null,
          probeId: null,
          selectionId: null,
          clearGuardUntil: Date.now() + 1500,
          closed: null
        });
        persist();
        emit();
        try {
          var uiWorkspace = ctx.get("uiWorkspace");
          if (uiWorkspace && typeof uiWorkspace.clearMain === "function") uiWorkspace.clearMain();
        } catch (e) {
          try { console.warn("[dsh-session-tabs] clearMain failed", e); } catch (e2) { /* ignore */ }
        }
      }

      function renameSession(ctx, id, title) {
        var sessions = null;
        try { sessions = ctx.get("sessions"); } catch (e) { sessions = null; }
        if (!sessions || !sessions.manager || typeof sessions.manager.rename !== "function") {
          return Promise.reject(new Error("rename unavailable"));
        }
        return sessions.manager.rename(id, title).then(function (result) {
          if (result && result.ok === true) return true;
          var message = result && result.error && result.error.message ? result.error.message : "rename failed";
          throw new Error(message);
        });
      }

      // ─────────────────────────────────────────────────────────────────────
      // icons
      // ─────────────────────────────────────────────────────────────────────
      function FolderIcon() {
        return h("svg", {
          width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
          "aria-hidden": "true", className: "dshst-icon"
        }, h("path", {
          d: "M1.75 4.25c0-.69.56-1.25 1.25-1.25h3.1c.33 0 .65.13.88.37l.9.9c.24.24.56.37.89.37h4.23c.69 0 1.25.56 1.25 1.25v6.36c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25V4.25Z",
          stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round"
        }));
      }

      function CloseIcon() {
        return h("svg", {
          width: 10, height: 10, viewBox: "0 0 10 10", fill: "none",
          "aria-hidden": "true"
        }, h("path", {
          d: "M1.5 1.5l7 7M8.5 1.5l-7 7",
          stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round"
        }));
      }

      // ─────────────────────────────────────────────────────────────────────
      // components
      // ─────────────────────────────────────────────────────────────────────
      function basename(p) {
        if (typeof p !== "string" || p === "") return "";
        var s = p.replace(/[\\/]+$/, "");
        if (s === "") return "";
        var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
        return i < 0 ? s : s.slice(i + 1);
      }

      function useStore() {
        return React.useSyncExternalStore(subscribe, getState, getState);
      }

      function statusOf(store, row) {
        var statuses = store.statuses;
        if (statuses && typeof statuses.get === "function") {
          var status = statuses.get(row.id);
          if (status) {
            if (status.pendingInteraction) return "pending";
            if (status.running) return "running";
            if (status.completionUnread) return "done";
            return "idle";
          }
        }
        return row.running ? "running" : "idle";
      }

      function CloseButton(props) {
        return h("button", {
          type: "button",
          className: "dshst-close",
          title: props.t("close"),
          "aria-label": props.t("close"),
          onClick: function (event) {
            event.stopPropagation();
            closeTab(props.ctx, props.id);
          },
          onContextMenu: function (event) {
            event.preventDefault();
            event.stopPropagation();
          }
        }, CloseIcon());
      }

      function useMenuPosition(x, y, width, height) {
        var ref = React.useRef(null);
        var posState = React.useState({ x: x, y: y });
        var pos = posState[0];
        var setPos = posState[1];
        React.useLayoutEffect(function () {
          var viewportW = root.innerWidth || 1024;
          var viewportH = root.innerHeight || 768;
          var w = width;
          var hgt = height;
          var el = ref.current;
          if (el && typeof el.getBoundingClientRect === "function") {
            var rect = el.getBoundingClientRect();
            if (rect.width > 0) w = rect.width;
            if (rect.height > 0) hgt = rect.height;
          }
          var nextX = Math.max(8, Math.min(x, viewportW - w - 8));
          var nextY = Math.max(8, Math.min(y, viewportH - hgt - 8));
          if (nextX !== pos.x || nextY !== pos.y) setPos({ x: nextX, y: nextY });
        }, [x, y, width, height]);
        return { ref: ref, pos: pos };
      }

      function TabContextMenu(props) {
        var ctx = props.ctx;
        var t = props.t;
        var targetId = props.targetId;
        var total = props.total;
        var row = props.row;
        var canRename = true;
        if (row && row.blank) canRename = false;
        else if (typeof props.useSessionAccess === "function") {
          canRename = props.useSessionAccess(targetId, "session/rename") !== false;
        }
        var items = [
          { key: "rename", label: t("menu.rename"), disabled: !canRename, onSelect: props.onRename },
          { key: "close", label: t("menu.close"), disabled: total === 0, onSelect: props.onCloseTab },
          { key: "closeOthers", label: t("menu.closeOthers"), count: Math.max(0, total - 1), disabled: total <= 1, onSelect: props.onCloseOthers },
          { key: "closeAll", label: t("menu.closeAll"), count: total, disabled: total === 0, onSelect: props.onCloseAll }
        ];
        var itemsRef = React.useRef(items);
        itemsRef.current = items;
        var indexState = React.useState(0);
        var activeIndex = indexState[0];
        var setActiveIndex = indexState[1];
        var position = useMenuPosition(props.x, props.y, 180, 4 * 32 + 8);

        React.useEffect(function () {
          var firstEnabled = 0;
          for (var i = 0; i < itemsRef.current.length; i++) {
            if (!itemsRef.current[i].disabled) { firstEnabled = i; break; }
          }
          setActiveIndex(firstEnabled);
        }, []);

        React.useEffect(function () {
          function onPointerDown(event) {
            var el = position.ref.current;
            if (el && event.target instanceof Node && el.contains(event.target)) return;
            props.onClose();
          }
          function onKey(event) {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              props.onClose();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              var list = itemsRef.current;
              var step = event.key === "ArrowDown" ? 1 : -1;
              var idx = activeIndex;
              for (var guard = 0; guard < list.length; guard++) {
                idx = (idx + step + list.length) % list.length;
                if (!list[idx].disabled) break;
              }
              setActiveIndex(idx);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              var item = itemsRef.current[activeIndex];
              if (item && !item.disabled) item.onSelect();
            }
          }
          document.addEventListener("mousedown", onPointerDown, true);
          document.addEventListener("keydown", onKey, true);
          document.addEventListener("scroll", props.onClose, true);
          root.addEventListener("blur", props.onClose);
          return function () {
            document.removeEventListener("mousedown", onPointerDown, true);
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("scroll", props.onClose, true);
            root.removeEventListener("blur", props.onClose);
          };
        }, [activeIndex, props]);

        var menu = h("div", {
          ref: position.ref,
          className: "dshst-menu",
          role: "menu",
          tabIndex: -1,
          style: { left: position.pos.x + "px", top: position.pos.y + "px" }
        }, items.map(function (item, index) {
          return h("div", {
            key: item.key,
            role: "menuitem",
            className: "dshst-menu-item",
            "data-hovered": index === activeIndex && !item.disabled ? "true" : "false",
            "data-disabled": item.disabled ? "true" : "false",
            onMouseEnter: function () { if (!item.disabled) setActiveIndex(index); },
            onClick: function () { if (!item.disabled) item.onSelect(); }
          },
            h("span", { className: "dshst-menu-label" }, item.label),
            typeof item.count === "number"
              ? h("span", { className: "dshst-menu-count" }, "(" + item.count + ")")
              : null
          );
        }));
        return ReactDOM.createPortal(menu, document.body);
      }

      function RenamePopup(props) {
        var ctx = props.ctx;
        var t = props.t;
        var valueState = React.useState(props.initial || "");
        var value = valueState[0];
        var setValue = valueState[1];
        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var errorState = React.useState("");
        var error = errorState[0];
        var setError = errorState[1];
        var inputRef = React.useRef(null);
        var position = useMenuPosition(props.x, props.y, 280, 120);

        React.useEffect(function () {
          var input = inputRef.current;
          if (input === null) return;
          try {
            input.focus();
            if (typeof input.select === "function") input.select();
          } catch (e) { /* ignore */ }
        }, []);

        React.useEffect(function () {
          function onPointerDown(event) {
            var el = position.ref.current;
            if (el && event.target instanceof Node && el.contains(event.target)) return;
            if (!busy) props.onClose();
          }
          function onKey(event) {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              event.stopPropagation();
              props.onClose();
            }
          }
          document.addEventListener("mousedown", onPointerDown, true);
          document.addEventListener("keydown", onKey, true);
          return function () {
            document.removeEventListener("mousedown", onPointerDown, true);
            document.removeEventListener("keydown", onKey, true);
          };
        }, [busy, props]);

        function submit() {
          if (busy) return;
          var next = value.trim();
          if (next === "") {
            setError(t("rename.empty"));
            return;
          }
          setBusy(true);
          setError("");
          renameSession(ctx, props.id, next)
            .then(function () {
              try { syncFromList(ctx.get("sessions").list.getSnapshot()); } catch (e) { /* ignore */ }
              props.onClose();
            })
            .catch(function (reason) {
              setBusy(false);
              setError((reason && reason.message ? String(reason.message) : t("rename.failed")));
            });
        }

        var popup = h("div", {
          ref: position.ref,
          className: "dshst-rename",
          role: "dialog",
          "aria-label": t("rename.title"),
          style: { left: position.pos.x + "px", top: position.pos.y + "px" }
        },
          h("div", { className: "dshst-rename-title" }, t("rename.title")),
          h("input", {
            ref: inputRef,
            className: "dshst-rename-input",
            type: "text",
            value: value,
            placeholder: t("rename.placeholder"),
            disabled: busy,
            "data-invalid": error !== "" ? "true" : "false",
            onChange: function (event) { setValue(event.target.value); if (error !== "") setError(""); },
            onKeyDown: function (event) {
              if (event.key === "Enter") { event.preventDefault(); submit(); }
              else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
            }
          }),
          error !== "" ? h("div", { className: "dshst-rename-error" }, error) : null,
          h("div", { className: "dshst-rename-actions" },
            h("button", {
              type: "button",
              className: "dshst-btn",
              disabled: busy,
              onClick: function () { props.onClose(); }
            }, t("rename.cancel")),
            h("button", {
              type: "button",
              className: "dshst-btn",
              "data-primary": "true",
              disabled: busy,
              onClick: submit
            }, t("rename.save"))
          )
        );
        return ReactDOM.createPortal(popup, document.body);
      }

      function TabStrip(props) {
        var store = props.store;
        var list = store.list || { byId: {} };
        var tabs = store.tabs || [];
        var ctx = props.ctx;
        var t = props.t;
        var current = store.currentId || currentSessionId(list) || store.active;
        var menuState = React.useState(null);
        var menu = menuState[0];
        var setMenu = menuState[1];
        var renameState = React.useState(null);
        var rename = renameState[0];
        var setRename = renameState[1];

        if (tabs.length === 0) return null;

        function openTabMenu(event, id) {
          event.preventDefault();
          event.stopPropagation();
          setMenu({ id: id, x: event.clientX, y: event.clientY });
        }

        var strip = h("div", {
          className: "dshst-tabs",
          role: "tablist",
          "aria-label": t("tabs.aria")
        }, tabs.map(function (id) {
          var row = list.byId ? list.byId[id] : undefined;
          var label;
          if (row && row.blank) label = t("newSession");
          else if (row && row.title && row.title.trim() !== "") label = row.title.trim();
          else if (store.titles[id]) label = store.titles[id];
          else label = t("untitled");
          var workspace = workspaceTitleFor(store, id, row);
          var active = id === current;
          var status = row ? statusOf(store, row) : "idle";
          var title = (workspace ? workspace + " / " : "") + label + (row && row.cwd ? "\n" + row.cwd : "");
          return h("div", {
            key: id,
            className: "dshst-tab",
            role: "tab",
            tabIndex: active ? 0 : -1,
            "aria-selected": active ? "true" : "false",
            "data-active": active ? "true" : "false",
            "data-status": status,
            "data-session-id": id,
            "data-menu-target": menu !== null && menu.id === id ? "true" : "false",
            title: title,
            onClick: function () { openSession(ctx, id); },
            onAuxClick: function (event) {
              if (event.button === 1) closeTab(ctx, id);
            },
            onContextMenu: function (event) { openTabMenu(event, id); },
            onKeyDown: function (event) {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openSession(ctx, id);
              }
            }
          },
            h("span", { className: "dshst-dot", "aria-hidden": "true" }),
            workspace
              ? h("span", { className: "dshst-ws", title: workspace }, workspace)
              : null,
            workspace
              ? h("span", { className: "dshst-sep", "aria-hidden": "true" }, "/")
              : null,
            h("span", { className: "dshst-label" }, label),
            h(CloseButton, { ctx: ctx, id: id, t: t })
          );
        }));

        var overlays = [];
        if (menu !== null) {
          var menuTarget = menu.id;
          var menuRow = list.byId ? list.byId[menuTarget] : undefined;
          overlays.push(h(TabContextMenu, {
            key: "menu",
            ctx: ctx,
            t: t,
            x: menu.x,
            y: menu.y,
            targetId: menuTarget,
            row: menuRow,
            total: tabs.length,
            useSessionAccess: props.useSessionAccess,
            onClose: function () { setMenu(null); },
            onRename: function () {
              setMenu(null);
              setRename({ id: menuTarget, x: menu.x, y: menu.y });
            },
            onCloseTab: function () { setMenu(null); closeTab(ctx, menuTarget); },
            onCloseOthers: function () { setMenu(null); closeOtherTabs(ctx, menuTarget); },
            onCloseAll: function () { setMenu(null); closeAllTabs(ctx); }
          }));
        }
        if (rename !== null) {
          var renameRow = list.byId ? list.byId[rename.id] : undefined;
          var initialTitle = renameRow && typeof renameRow.title === "string" ? renameRow.title : "";
          overlays.push(h(RenamePopup, {
            key: "rename",
            ctx: ctx,
            t: t,
            id: rename.id,
            initial: initialTitle,
            x: rename.x,
            y: rename.y,
            onClose: function () { setRename(null); }
          }));
        }
        var overlay = overlays.length > 0
          ? ReactDOM.createPortal(h(React.Fragment, null, overlays), document.body)
          : null;
        return h(React.Fragment, null, strip, overlay);
      }

      /**
       * Headless current-session probe: lives in the strict Session header's
       * actions list, so it is mounted with the exact `sessionId` being shown.
       */
      function CurrentProbe(props) {
        var id = typeof props.sessionId === "string" ? props.sessionId : null;
        React.useEffect(function () {
          if (id !== null) setProbeId(id);
          return function () { clearProbeId(id); };
        }, [id]);
        return null;
      }

      /**
       * Header-leading occupant: renders the workspace info inline, and portals
       * the tab strip into one extra header row (the conversation root header is
       * a grid; an appended child becomes the row below the View tabs).
       */
      function Leading(props) {
        var ctx = props.ctx;
        var t = props.t;
        var store = useStore();
        var anchorRef = React.useRef(null);
        var rowState = React.useState(null);
        var row = rowState[0];
        var setRow = rowState[1];

        React.useLayoutEffect(function () {
          var anchor = anchorRef.current;
          if (!anchor || typeof anchor.closest !== "function") return undefined;
          var header = anchor.closest("header");
          if (!header || header.querySelector("[data-dsh-session-tabs]")) return undefined;
          var el = document.createElement("div");
          el.className = "dshst-row";
          el.setAttribute("data-dsh-session-tabs", "");
          header.appendChild(el);
          setRow(el);
          // The header is React-managed: when React mounts/reorders its own grid
          // children it can insert them after our appended row, which would flip
          // the auto-placement order. Keep our row last on every child mutation.
          var observer = null;
          if (typeof MutationObserver === "function") {
            observer = new MutationObserver(function () {
              if (el.parentNode === header && header.lastElementChild !== el) header.appendChild(el);
            });
            observer.observe(header, { childList: true });
          }
          return function () {
            if (observer !== null) observer.disconnect();
            if (el.parentNode) el.parentNode.removeChild(el);
            setRow(null);
          };
        }, []);

        var list = store.list;
        var current = store.currentId || currentSessionId(list);
        var rowData = current && list && list.byId ? list.byId[current] : undefined;
        var cwd = rowData && typeof rowData.cwd === "string" ? rowData.cwd : "";
        var workspace = workspaceTitleFor(store, current, rowData);

        var leading = h("span", { className: "dshst-leading", ref: anchorRef },
          workspace
            ? h(React.Fragment, null,
                h(FolderIcon),
                h("span", { className: "dshst-ws", title: cwd }, workspace),
                h("span", { className: "dshst-sep", "aria-hidden": "true" }, "/"))
            : null
        );

        var strip = null;
        if (row && typeof ReactDOM.createPortal === "function") {
          strip = ReactDOM.createPortal(
            h(TabStrip, { store: store, ctx: ctx, t: t, useSessionAccess: props.useSessionAccess }),
            row
          );
        }

        return h(React.Fragment, null, leading, strip);
      }

      // ─────────────────────────────────────────────────────────────────────
      // styles
      // ─────────────────────────────────────────────────────────────────────
      var CSS = [
        ".dshst-leading{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:20px;-webkit-app-region:no-drag}",
        ".dshst-icon{flex:none;opacity:.9}",
        ".dshst-ws{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dshst-leading .dshst-ws{max-width:180px}",
        ".dshst-sep{color:var(--dsw-alias-label-caption);flex:none}",
        ".dshst-row{--dshst-tab-accent:#e6cca0;grid-column:1/-1;min-width:0;padding-left:8px;margin-top:0;display:flex;align-items:flex-start;-webkit-app-region:no-drag}",
        "header:has(> [data-dsh-session-tabs]){padding-bottom:0}",
        ".dshst-tabs{display:flex;align-items:center;gap:0;min-width:0;width:100%;overflow-x:auto;scrollbar-width:none;padding:0}",
        ".dshst-tabs::-webkit-scrollbar{display:none}",
        ".dshst-tab{display:inline-flex;align-items:center;gap:6px;flex:none;max-width:300px;min-width:0;min-height:24px;padding:4px 10px 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;font-weight:500;line-height:16px;cursor:pointer;position:relative;-webkit-app-region:no-drag}",
        ".dshst-tab:before{content:\"\";position:absolute;inset:0;border:1px solid transparent;border-bottom:0;border-radius:6px 6px 0 0;pointer-events:none}",
        ".dshst-tab .dshst-ws{max-width:110px;flex:none;color:var(--dsw-alias-label-caption);font-size:12px;font-weight:500;line-height:16px}",
        ".dshst-tab .dshst-sep{font-size:12px;opacity:.9}",
        "@media (hover:hover){.dshst-tab:hover{color:var(--dsw-alias-label-secondary)}.dshst-tab:hover:before{border-color:var(--dsw-alias-border-l3)}}",
        ".dshst-tab:focus-visible:before{border-color:var(--dsw-alias-border-l3)}",
        ".dshst-tab[data-active=\"true\"]{color:var(--dsw-alias-state-business-primary)}",
        ".dshst-tab[data-active=\"true\"]:before{border-color:var(--dsw-alias-border-l4)}",
        ".dshst-tab[data-active=\"true\"] .dshst-ws,.dshst-tab[data-active=\"true\"] .dshst-sep{color:var(--dsw-alias-state-business-primary);opacity:.65}",
        ".dshst-tab[data-active=\"true\"]:after{content:\"\";position:absolute;left:0;right:0;bottom:0;height:2px;border-radius:2px 2px 0 0;background:var(--dshst-tab-accent)}",
        ".dshst-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}",
        ".dshst-tab[data-status=\"running\"] .dshst-dot{background:var(--dsw-alias-state-business-primary);animation:dshst-pulse 1.6s ease-in-out infinite}",
        ".dshst-tab[data-status=\"pending\"] .dshst-dot{background:var(--dsw-alias-state-warn-primary)}",
        ".dshst-tab[data-status=\"done\"] .dshst-dot{background:var(--dsw-alias-state-success-primary)}",
        "@keyframes dshst-pulse{0%,100%{opacity:1}50%{opacity:.35}}",
        ".dshst-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dshst-close{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;margin-left:2px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0}",
        ".dshst-tab:hover .dshst-close,.dshst-tab:focus-within .dshst-close{opacity:1}",
        "@media (hover:hover){.dshst-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}",
        "@media (prefers-reduced-motion:reduce){.dshst-tab[data-status=\"running\"] .dshst-dot{animation:none}}",
        ".dshst-tab[data-menu-target=\"true\"]{background:var(--dsw-alias-interactive-bg-hover)}",
        ".dshst-menu{position:fixed;z-index:1200;min-width:180px;box-sizing:border-box;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);box-shadow:0 10px 30px rgba(0,0,0,.35);outline:none;-webkit-app-region:no-drag}",
        ".dshst-menu-item{display:flex;align-items:center;justify-content:space-between;gap:18px;height:32px;padding:0 10px;border-radius:5px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:16px;cursor:pointer;white-space:nowrap;user-select:none}",
        ".dshst-menu-item[data-hovered=\"true\"]{background:var(--dsw-alias-interactive-bg-hover)}",
        ".dshst-menu-item[data-disabled=\"true\"]{color:var(--dsw-alias-label-dimmed);cursor:default;background:transparent}",
        ".dshst-menu-count{color:var(--dsw-alias-label-caption);font-size:12px;font-variant-numeric:tabular-nums}",
        ".dshst-menu-item[data-disabled=\"true\"] .dshst-menu-count{color:var(--dsw-alias-label-dimmed)}",
        ".dshst-rename{position:fixed;z-index:1201;width:280px;box-sizing:border-box;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);box-shadow:0 12px 32px rgba(0,0,0,.4);-webkit-app-region:no-drag}",
        ".dshst-rename-title{margin-bottom:8px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:16px}",
        ".dshst-rename-input{width:100%;box-sizing:border-box;height:32px;padding:0 9px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}",
        ".dshst-rename-input:focus{border-color:var(--dsw-alias-state-business-primary)}",
        ".dshst-rename-input[data-invalid=\"true\"]{border-color:var(--dsw-alias-label-error)}",
        ".dshst-rename-error{margin-top:6px;color:var(--dsw-alias-label-error);font-size:12px;line-height:16px}",
        ".dshst-rename-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}",
        ".dshst-btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;cursor:pointer}",
        ".dshst-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
        ".dshst-btn[data-primary=\"true\"]{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}",
        ".dshst-btn:disabled{opacity:.6;cursor:default}"
      ].join("\n");

      function installStyles() {
        if (document.getElementById(STYLE_ID) !== null) return;
        var style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
      }

      function removeStyles() {
        var style = document.getElementById(STYLE_ID);
        if (style !== null && style.parentNode !== null) style.parentNode.removeChild(style);
      }

      // ─────────────────────────────────────────────────────────────────────
      // plugin body
      // ─────────────────────────────────────────────────────────────────────
      function apply(ctx) {
        if (!React || !ReactDOM) return;
        loadPersisted();

        try {
          ctx.effect(function () {
            return ctx.locale.register(NS, UI);
          }, "dsh-session-tabs: locale dictionaries");
        } catch (e) { /* locale optional: fall back to zh strings below */ }

        var t;
        try {
          t = ctx.locale.bind(NS);
        } catch (e) {
          t = function (key) {
            var dict = UI.zh;
            return dict[key] !== undefined ? dict[key] : key;
          };
        }

        installStyles();

        ctx.effect(function () {
          return function () { removeStyles(); };
        }, "dsh-session-tabs: styles");

        ctx.effect(function () {
          var unsubs = [];
          var uiSession = null;
          var statusStore = null;
          var workspaceService = null;
          var selectionStore = null;
          var workspacesService = null;
          var workspacesStore = null;
          var retryTimer = null;

          if (ctx.sessions && ctx.sessions.list) {
            var listStore = ctx.sessions.list;
            if (typeof listStore.getSnapshot === "function") syncFromList(listStore.getSnapshot());
            if (typeof listStore.subscribe === "function") {
              unsubs.push(listStore.subscribe(function () { syncFromList(listStore.getSnapshot()); }));
            }
          }

          function bindUiSession() {
            if (statusStore !== null) return true;
            if (uiSession === null) {
              try { uiSession = ctx.get("uiSession"); } catch (e) { uiSession = null; }
            }
            if (!uiSession || !uiSession.sessionStatus) return false;
            statusStore = uiSession.sessionStatus;
            if (typeof statusStore.getSnapshot === "function") syncFromStatuses(statusStore.getSnapshot());
            if (typeof statusStore.subscribe === "function") {
              unsubs.push(statusStore.subscribe(function () { syncFromStatuses(statusStore.getSnapshot()); }));
            }
            if (!state.uiBound) {
              state = Object.assign({}, state, { uiBound: true });
              emit();
            }
            return true;
          }

          function bindWorkspaceSelection() {
            if (selectionStore !== null) return true;
            if (workspaceService === null) {
              try { workspaceService = ctx.get("uiWorkspace"); } catch (e) { workspaceService = null; }
            }
            var selection = workspaceService && workspaceService.selection;
            if (!selection || typeof selection.subscribe !== "function") return false;
            selectionStore = selection;
            if (typeof selectionStore.getSnapshot === "function") syncSelection(selectionStore.getSnapshot());
            unsubs.push(selectionStore.subscribe(function () { syncSelection(selectionStore.getSnapshot()); }));
            return true;
          }

          function bindWorkspaces() {
            if (workspacesStore !== null) return true;
            if (workspacesService === null) {
              try { workspacesService = ctx.get("workspaces"); } catch (e) { workspacesService = null; }
            }
            var store = workspacesService && workspacesService.list;
            if (!store || typeof store.subscribe !== "function") return false;
            workspacesStore = store;
            if (typeof store.getSnapshot === "function") syncFromWorkspaces(store.getSnapshot());
            unsubs.push(store.subscribe(function () { syncFromWorkspaces(store.getSnapshot()); }));
            return true;
          }

          function bindAll() {
            return bindUiSession() && bindWorkspaceSelection() && bindWorkspaces();
          }

          if (!bindAll()) {
            var attempts = 0;
            retryTimer = root.setInterval(function () {
              attempts += 1;
              if (bindAll() || attempts >= 60) {
                root.clearInterval(retryTimer);
                retryTimer = null;
              }
            }, 1000);
          }

          return function () {
            if (retryTimer !== null) root.clearInterval(retryTimer);
            for (var i = 0; i < unsubs.length; i++) {
              try { unsubs[i](); } catch (e) { /* ignore */ }
            }
          };
        }, "dsh-session-tabs: session subscriptions");

        // The strict session header's actions list is a per-session list slot;
        // the probe entry gives us the exact session id the shell renders.
        try {
          var disposeProbe = ctx.slots.inject("conversation.session.header.actions", function () {
            return ctx.slots.register({
              name: "conversation.session.header.actions",
              id: "dsh-session-tabs-current",
              order: -100,
              inject: function () { return { ctx: ctx }; }
            }, CurrentProbe);
          });
          ctx.effect(function () {
            return function () {
              if (typeof disposeProbe === "function") disposeProbe();
            };
          }, "dsh-session-tabs: current-session probe");
        } catch (e) {
          try { console.warn("[dsh-session-tabs] session header actions slot unavailable", e); } catch (e2) { /* ignore */ }
        }

        // The header-leading slot is declared by ui-conversation; inject() waits
        // for that declaration (and re-registers after plugin reloads).
        try {
          var disposeRegistration = ctx.slots.inject("conversation.header.leading", function () {
            return ctx.slots.register({
              name: "conversation.header.leading",
              locale: NS,
              inject: function () { return { ctx: ctx }; }
            }, Leading);
          });
          ctx.effect(function () {
            return function () {
              if (typeof disposeRegistration === "function") disposeRegistration();
            };
          }, "dsh-session-tabs: header registration");
        } catch (e) {
          try { console.warn("[dsh-session-tabs] header-leading slot unavailable", e); } catch (e2) { /* ignore */ }
        }

        try {
          console.log("[dsh-session-tabs] active (tabs: " + state.tabs.length + ")");
        } catch (e) { /* ignore */ }
      }

      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    }
  });
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : null);
