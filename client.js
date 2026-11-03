/**
 * dsh-panel-compact —— 左侧栏「插件面板」收纳。
 *
 * 诉求：左侧栏顶部那排插件面板入口太多，把下面的工作区挤小了。
 * 做法：
 *   1. 默认只让前 3 个面板留在侧栏里，其余行从视觉上收起（不改插件本身）；
 *   2. 留下的那几行可以用鼠标拖动排序，顺序记在 localStorage；
 *   3. 注册 `sidebar.panellist.actions`，让外壳的「更多」菜单里列出全部面板：
 *      点一下直接打开，右侧 ✓/+ 按钮决定它在侧栏显示还是收进更多；
 *   4. 菜单里的行也能按住拖动排序（顺序就是侧栏顺序），字号跟侧栏行一致，
 *      并隐藏外壳自己加的那行「浏览更多插件」（重复入口）。
 *
 * 为什么不改核心：外壳的面板行按插件注册时的 `order` 排序，没有对外的排序
 * API；`sidebar.panellist.actions` 是外壳留给插件填充「更多」菜单的槽位，
 * 所以显隐与排序只能在浏览器侧完成（直接操作行元素的内联 style）。
 *
 * 安全阀：找不到「更多」入口时不做任何收纳，所有行原样显示 —— 免得面板
 * 被藏起来又没有入口打开。
 */
window.__ModuleLoader__.load({
  id: 'dsh-panel-compact',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useReducer } = React;

    const NS = 'dshPanelCompact';
    const PANEL_SLOT = 'sidebar.panellist';
    const ACTIONS_SLOT = 'sidebar.panellist.actions';
    const STORAGE_KEY = 'dsh-panel-compact.v1';
    const ID_ATTR = 'data-dshsc-id';
    const MENU_ID_ATTR = 'data-dshsc-menu-id';
    /** 侧栏里一共露几行（「插件」那行恒定显示，也占一个名额）。 */
    const TOTAL_VISIBLE = 3;
    const PLUGINS_ID = 'plugins';
    const DRAG_THRESHOLD = 6;
    /** 「更多」菜单里由外壳（entry-customization）加的「浏览更多插件」行：
     *  菜单里已经列着全部面板，插件列表从侧栏那行「插件」进得去，这行是重复入口。 */
    const HOST_HIDDEN_ROWS = ['浏览更多插件', 'Browse other plugins'];

    const ZH = {
      caption: '前 3 个留在侧栏，其余收进这里；点名字直接打开。',
      pin: '显示在侧栏',
      unpin: '收进更多',
      footnote: '侧栏和这里的行都可以按住鼠标上下拖动排序。',
      reset: '恢复默认（只留三个）',
    };
    const EN = {
      caption: 'Three stay in the sidebar; the rest live here. Click a name to open it.',
      pin: 'Show in sidebar',
      unpin: 'Move to More',
      footnote: 'Drag rows here or in the sidebar to reorder them.',
      reset: 'Reset to the default three',
    };

    /** 浏览器侧共享状态。 */
    const state = { initialized: false, order: [], pinned: [] };
    const listeners = new Set();

    let ctxRef = null;
    let translate = (key) => key;
    let observer = null;
    let observerNav = null;
    /** 从 localStorage 里读到过的面板 id：这些条目哪怕暂时没注册也不裁掉。 */
    let seeded = new Set();
    let styleTag = null;

    // ---------------------------------------------------------------- state

    function load() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return;
        if (Array.isArray(parsed.order)) {
          state.order = parsed.order.filter((id) => typeof id === 'string' && id !== '');
        }
        if (Array.isArray(parsed.pinned)) {
          state.pinned = parsed.pinned.filter((id) => typeof id === 'string' && id !== '');
        }
        state.initialized = parsed.initialized === true;
        seeded = new Set([...state.order, ...state.pinned]);
      } catch {
        /* 存储坏了就按默认值走 */
      }
    }

    function save() {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* 隐身模式或配额满：本轮仍然生效，只是不持久化 */
      }
    }

    function emit() {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          /* 单个订阅者出错不影响其它人 */
        }
      }
    }

    // ---------------------------------------------------------------- panels

    function resolveLabel(options) {
      let label = options.label;
      if (typeof label === 'function') {
        try {
          label = label();
        } catch {
          label = undefined;
        }
      }
      if (label !== null && typeof label === 'object') {
        label = label.zh ?? label.en ?? options.id;
      }
      if (typeof label !== 'string' || label === '') return options.id;
      return label;
    }

    function readPanels() {
      const ctx = ctxRef;
      if (!ctx || !ctx.slots || typeof ctx.slots.entriesOfSlot !== 'function') return [];
      let entries = [];
      try {
        entries = ctx.slots.entriesOfSlot(PANEL_SLOT) || [];
      } catch {
        entries = [];
      }
      const panels = [];
      for (const entry of entries) {
        const options = entry && entry.options ? entry.options : {};
        const id = options.id;
        if (typeof id !== 'string' || id === '') continue;
        panels.push({
          id,
          order: Number.isFinite(options.order) ? options.order : 0,
          label: resolveLabel(options),
        });
      }
      panels.sort((a, b) => a.order - b.order);
      return panels;
    }

    function reconcile(panels) {
      const ids = panels.map((panel) => panel.id);
      // 插件是陆续注册的：启动后头几个 tick 往往只看得到一部分面板。
      // 所以只清理「本次会话里新加进来、现在又不见了」的条目；从 localStorage
      // 读出来的条目即使这一 tick 还没注册也先留着，否则会把它们裁掉再按注册顺序
      // 追加到末尾，表现成「重启后侧栏少一行、菜单顺序乱掉」。
      const keep = (id) => ids.includes(id) || seeded.has(id);
      state.order = state.order.filter(keep);
      for (const id of ids) {
        if (!state.order.includes(id)) state.order.push(id);
      }
      if (!state.initialized) {
        // 「插件」那行外壳恒定渲染，先把它的名额扣掉。
        const budget = Math.max(1, TOTAL_VISIBLE - (ids.includes(PLUGINS_ID) ? 1 : 0));
        state.pinned = ids.filter((id) => id !== PLUGINS_ID).slice(0, budget);
        state.initialized = true;
      } else {
        state.pinned = state.pinned.filter(keep);
      }
      state.pinned.sort((a, b) => state.order.indexOf(a) - state.order.indexOf(b));
    }

    function syncOrderFromPinned() {
      const rest = state.order.filter((id) => !state.pinned.includes(id));
      state.order = [...state.pinned, ...rest];
    }

    function visibleIds() {
      return state.pinned.filter((id) => id !== PLUGINS_ID);
    }

    function displayIds(ids) {
      const visible = visibleIds();
      return ids.includes(PLUGINS_ID) ? [PLUGINS_ID, ...visible] : visible;
    }

    // --------------------------------------------------------------- the DOM

    function isPanelList(nav) {
      return Array.from(nav.classList).some((name) => name.endsWith('_panelList') || name === 'panelList');
    }

    function findNav() {
      const anchors = document.querySelectorAll('button[aria-haspopup="menu"]');
      let fallback = null;
      for (const anchor of anchors) {
        const nav = anchor.closest('nav');
        if (nav === null) continue;
        // 外壳的类名带构建哈希（如 kB3qhq_panelList），按后缀认最稳。
        if (isPanelList(nav)) return nav;
        if (fallback === null) fallback = nav;
      }
      return fallback;
    }

    function collectRows(nav) {
      const rows = [];
      let moreChild = null;
      for (const child of Array.from(nav.children)) {
        const button = child.matches('button') ? child : child.querySelector('button');
        if (button === null) continue;
        if (button.getAttribute('aria-haspopup') === 'menu') {
          moreChild = child;
          continue;
        }
        rows.push({ child, button });
      }
      return { rows, moreChild };
    }

    function mapRowsToIds(rows, panels) {
      if (rows.length === panels.length) return panels.map((panel) => panel.id);
      const byLabel = new Map(panels.map((panel) => [panel.label, panel.id]));
      return rows.map((row) => byLabel.get(row.button.getAttribute('aria-label') || ''));
    }

    function applyDom() {
      if (ctxRef === null) return;
      const nav = findNav();
      if (nav === null) return;
      const { rows, moreChild } = collectRows(nav);
      if (moreChild === null) {
        // 没有「更多」入口：不做收纳，全部原样显示。
        for (const row of rows) {
          row.child.style.removeProperty('display');
          row.child.style.removeProperty('order');
        }
        return;
      }
      const panels = readPanels();
      const ids = mapRowsToIds(rows, panels);
      const visible = displayIds(ids);
      const pinnedSet = state.pinned;
      rows.forEach((row, index) => {
        const id = ids[index];
        if (typeof id !== 'string' || id === '') {
          // 认不出来是谁就不动它，宁可多显示一行也不要藏掉入口。
          row.child.style.removeProperty('display');
          row.child.style.removeProperty('order');
          row.child.removeAttribute(ID_ATTR);
          return;
        }
        row.child.setAttribute(ID_ATTR, id);
        const slot = visible.indexOf(id);
        if (slot >= 0 || id === PLUGINS_ID) {
          row.child.style.removeProperty('display');
          row.child.style.order = String(Math.max(0, slot));
        } else {
          row.child.style.display = 'none';
          row.child.style.removeProperty('order');
        }
      });
      moreChild.style.setProperty('order', String(visible.length));
    }

    function refresh() {
      const panels = readPanels();
      if (panels.length > 0) {
        reconcile(panels);
        applyDom();
      }
      syncMenuFont();
      tidyMenu();
      emit();
    }

    function watchNav() {
      const nav = findNav();
      if (nav === null) {
        window.setTimeout(watchNav, 300);
        return;
      }
      if (observer !== null && observerNav === nav) return;
      if (observer !== null) observer.disconnect();
      observer = new MutationObserver(() => refresh());
      observer.observe(nav, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label'],
      });
      observerNav = nav;
      refresh();
    }

    // ---------------------------------------------------------------- drag

    let drag = null;

    function directChildOf(nav, element) {
      let node = element;
      while (node !== null && node.parentElement !== null && node.parentElement !== nav) {
        node = node.parentElement;
      }
      return node;
    }

    function onPointerDown(event) {
      if (event.button !== 0 || drag !== null) return;
      const nav = findNav();
      if (nav === null) return;
      const target = event.target instanceof Element ? event.target.closest('button') : null;
      if (target === null || !nav.contains(target)) return;
      if (target.getAttribute('aria-haspopup') === 'menu') return;
      const child = directChildOf(nav, target);
      if (child === null) return;
      const id = child.getAttribute(ID_ATTR);
      if (typeof id !== 'string' || id === '' || id === PLUGINS_ID) return;
      drag = {
        id,
        child,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      window.addEventListener('pointermove', onPointerMove, true);
      window.addEventListener('pointerup', onPointerUp, true);
      window.addEventListener('pointercancel', onPointerUp, true);
    }

    function onPointerMove(event) {
      if (drag === null) return;
      if (!drag.moved) {
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        drag.moved = true;
        drag.child.classList.add('dshsc-dragging');
        document.body.classList.add('dshsc-drag-active');
      }
      event.preventDefault();
      reorderAt(event.clientY);
    }

    function reorderAt(clientY) {
      const nav = findNav();
      if (nav === null || drag === null) return;
      const { rows } = collectRows(nav);
      const candidates = [];
      rows.forEach((row) => {
        const id = row.child.getAttribute(ID_ATTR);
        // 「插件」行恒定在最前，不参与落点计算（否则落点会整体偏移一位）。
        if (typeof id !== 'string' || id === '' || id === drag.id || id === PLUGINS_ID) return;
        if (row.child.style.display === 'none') return;
        const rect = row.child.getBoundingClientRect();
        candidates.push({ id, top: rect.top, bottom: rect.bottom });
      });
      candidates.sort((a, b) => a.top - b.top);
      let target = candidates.length;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (clientY < candidate.top + (candidate.bottom - candidate.top) / 2) {
          target = index;
          break;
        }
      }
      const pinned = state.pinned.filter((id) => id !== drag.id);
      pinned.splice(Math.max(0, Math.min(target, pinned.length)), 0, drag.id);
      if (pinned.join('|') === state.pinned.join('|')) return;
      state.pinned = pinned;
      syncOrderFromPinned();
      applyDom();
    }

    function onPointerUp() {
      if (drag === null) return;
      const moved = drag.moved;
      const child = drag.child;
      drag = null;
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      child.classList.remove('dshsc-dragging');
      document.body.classList.remove('dshsc-drag-active');
      if (!moved) return;
      // 拖完浏览器还会补一个 click，别让它顺手切面板。
      const stopClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.removeEventListener('click', stopClick, true);
      };
      window.addEventListener('click', stopClick, true);
      window.setTimeout(() => window.removeEventListener('click', stopClick, true), 300);
      save();
      emit();
    }

    // ---------------------------------------------------------------- menu

    function open(id) {
      const ctx = ctxRef;
      if (ctx === null) return;
      try {
        ctx.layout.selectPanel(id);
      } catch {
        /* 老版本 layout 没有 selectPanel */
      }
    }

    function togglePin(id) {
      if (state.pinned.includes(id)) {
        state.pinned = state.pinned.filter((entry) => entry !== id);
      } else {
        state.pinned = [...state.pinned, id];
        state.pinned.sort((a, b) => state.order.indexOf(a) - state.order.indexOf(b));
      }
      syncOrderFromPinned();
      applyDom();
      save();
      emit();
    }

    function resetDefaults() {
      const panels = readPanels();
      const budget = Math.max(1, TOTAL_VISIBLE - (panels.some((p) => p.id === PLUGINS_ID) ? 1 : 0));
      state.order = panels.map((panel) => panel.id);
      state.pinned = state.order.filter((id) => id !== PLUGINS_ID).slice(0, budget);
      applyDom();
      save();
      emit();
    }

    // ------------------------------------------------------------- more menu

    /** 侧栏面板行此刻的**实际**字号。读不到就返回空串 —— 不猜、不写死，
     *  由 CSS 回退到继承，字号永远跟着外壳走（主题、缩放、外壳改版都行）。 */
    function sidebarRowFontSize() {
      const nav = findNav();
      if (nav === null) return '';
      const row = nav.querySelector('button');
      if (row === null) return '';
      const size = window.getComputedStyle(row).fontSize;
      return typeof size === 'string' ? size : '';
    }

    /** 把侧栏行的实际字号挂到 <html> 上，弹层（被 portal 到 body 之外）就能
     *  直接吃到；侧栏字号一变这里跟着变，菜单不需要重开。 */
    function syncMenuFont() {
      const root = document.documentElement;
      const size = sidebarRowFontSize();
      if (size === '') {
        if (root.style.getPropertyValue('--dshsc-menu-font') !== '') {
          root.style.removeProperty('--dshsc-menu-font');
        }
        return size;
      }
      if (root.style.getPropertyValue('--dshsc-menu-font') !== size) {
        root.style.setProperty('--dshsc-menu-font', size);
      }
      return size;
    }

    /** 侧栏字号可能被这些事改掉：换主题/调字号（html/body 的 class、style、
     *  data-* 属性）、字体加载完、窗口缩放。都只做一次轻量的重新读取。 */
    function watchFont() {
      const recount = () => syncMenuFont();
      const mo = new MutationObserver(recount);
      for (const target of [document.documentElement, document.body]) {
        if (target !== null) {
          mo.observe(target, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme', 'lang', 'dir'],
          });
        }
      }
      if (document.fonts && typeof document.fonts.addEventListener === 'function') {
        document.fonts.addEventListener('loadingdone', recount);
      }
      window.addEventListener('resize', recount);
      return () => {
        mo.disconnect();
        window.removeEventListener('resize', recount);
        if (document.fonts && typeof document.fonts.removeEventListener === 'function') {
          document.fonts.removeEventListener('loadingdone', recount);
        }
      };
    }

    /** 我们这个菜单块所在的弹层（外壳的 role=menu 容器）。 */
    function menuSurface() {
      const menu = document.querySelector('.dshsc-menu');
      return menu === null ? null : menu.closest('[role="menu"]');
    }

    /** 菜单一开就做两件外壳管不到的事：把字号对齐侧栏行、把重复的
     *  「浏览更多插件」行藏起来。弹层是外壳渲染的，所以只加 class / 内联样式，
     *  不改它的结构；找不到菜单时什么也不做。 */
    function tidyMenu() {
      const surface = menuSurface();
      if (surface === null) return;
      // 读不到侧栏字号时不挂 class：弹层保持外壳自己的排版，别硬塞一个尺寸。
      if (syncMenuFont() === '') surface.classList.remove('dshsc-host-menu');
      else surface.classList.add('dshsc-host-menu');
      for (const button of surface.querySelectorAll('button')) {
        if (button.style.display === 'none') continue;
        const text = (button.textContent || '').trim();
        if (!HOST_HIDDEN_ROWS.includes(text)) continue;
        button.style.display = 'none';
        button.setAttribute('aria-hidden', 'true');
      }
    }

    /** 菜单里拖动的落点：按行中心算目标位，然后整体重排 state.order。 */
    let menuDrag = null;

    function menuRows() {
      return Array.from(document.querySelectorAll('.dshsc-menu .dshsc-row'));
    }

    function onMenuPointerDown(event) {
      if (event.button !== 0 || menuDrag !== null) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target === null) return;
      const row = target.closest('.dshsc-row');
      if (row === null) return;
      const id = row.getAttribute(MENU_ID_ATTR);
      if (typeof id !== 'string' || id === '') return;
      menuDrag = { id, startY: event.clientY, moved: false };
      window.addEventListener('pointermove', onMenuPointerMove, true);
      window.addEventListener('pointerup', onMenuPointerUp, true);
      window.addEventListener('pointercancel', onMenuPointerUp, true);
    }

    function onMenuPointerMove(event) {
      if (menuDrag === null) return;
      if (!menuDrag.moved) {
        if (Math.abs(event.clientY - menuDrag.startY) < DRAG_THRESHOLD) return;
        menuDrag.moved = true;
        const row = document.querySelector(`.dshsc-menu .dshsc-row[${MENU_ID_ATTR}="${menuDrag.id}"]`);
        if (row !== null) row.classList.add('dshsc-dragging');
        document.body.classList.add('dshsc-drag-active');
      }
      event.preventDefault();
      reorderMenuAt(event.clientY);
    }

    function reorderMenuAt(clientY) {
      if (menuDrag === null) return;
      const anchors = [];
      for (const row of menuRows()) {
        const id = row.getAttribute(MENU_ID_ATTR);
        if (typeof id !== 'string' || id === '' || id === menuDrag.id) continue;
        const rect = row.getBoundingClientRect();
        anchors.push({ id, top: rect.top, bottom: rect.bottom });
      }
      anchors.sort((a, b) => a.top - b.top);
      let slot = anchors.length;
      for (let index = 0; index < anchors.length; index += 1) {
        const anchor = anchors[index];
        if (clientY < anchor.top + (anchor.bottom - anchor.top) / 2) {
          slot = index;
          break;
        }
      }
      const order = state.order.filter((id) => id !== menuDrag.id);
      const before = anchors[slot];
      const at = before === undefined ? order.length : order.indexOf(before.id);
      order.splice(at < 0 ? order.length : at, 0, menuDrag.id);
      if (order.join('|') === state.order.join('|')) return;
      state.order = order;
      state.pinned.sort((a, b) => state.order.indexOf(a) - state.order.indexOf(b));
      applyDom();
      save();
      emit();
    }

    function onMenuPointerUp() {
      if (menuDrag === null) return;
      const moved = menuDrag.moved;
      menuDrag = null;
      window.removeEventListener('pointermove', onMenuPointerMove, true);
      window.removeEventListener('pointerup', onMenuPointerUp, true);
      window.removeEventListener('pointercancel', onMenuPointerUp, true);
      const row = document.querySelector('.dshsc-menu .dshsc-row.dshsc-dragging');
      if (row !== null) row.classList.remove('dshsc-dragging');
      document.body.classList.remove('dshsc-drag-active');
      if (!moved) return;
      // 拖完浏览器还会补一个 click，别让它顺手打开面板。
      const stopClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.removeEventListener('click', stopClick, true);
      };
      window.addEventListener('click', stopClick, true);
      window.setTimeout(() => window.removeEventListener('click', stopClick, true), 300);
    }

    function usePanelStore() {
      const [, force] = useReducer((value) => value + 1, 0);
      useEffect(() => {
        listeners.add(force);
        return () => listeners.delete(force);
      }, [force]);
    }

    function MorePanel(props) {
      usePanelStore();
      // 菜单里的行按用户排好的顺序走（拖动排序的结果要在这里看得到）。
      const panels = readPanels()
        .filter((panel) => panel.id !== PLUGINS_ID)
        .sort((a, b) => {
          const left = state.order.indexOf(a.id);
          const right = state.order.indexOf(b.id);
          return (left < 0 ? Number.MAX_SAFE_INTEGER : left) - (right < 0 ? Number.MAX_SAFE_INTEGER : right);
        });
      const pinned = state.pinned.slice();
      // 挂上就把字号/重复行收拾好：弹层刚渲染出来的那一刻还不存在，
      // 所以不能在 render 里做，得等提交之后。
      useEffect(() => {
        tidyMenu();
      });
      return h(
        'div',
        { className: 'dshsc-menu', onPointerDown: onMenuPointerDown },
        h('div', { className: 'dshsc-caption' }, translate('caption')),
        panels.map((panel) => {
          const isPinned = pinned.includes(panel.id);
          return h(
            'div',
            { key: panel.id, className: 'dshsc-row', [MENU_ID_ATTR]: panel.id },
            h(
              'button',
              {
                type: 'button',
                className: 'dshsc-label',
                onClick: () => {
                  open(panel.id);
                  if (props && typeof props.onDismiss === 'function') props.onDismiss();
                },
              },
              panel.label,
            ),
            h(
              'button',
              {
                type: 'button',
                className: `dshsc-toggle${isPinned ? ' is-on' : ''}`,
                title: translate(isPinned ? 'unpin' : 'pin'),
                'aria-label': translate(isPinned ? 'unpin' : 'pin'),
                onClick: (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  togglePin(panel.id);
                },
              },
              isPinned ? '✓' : '＋',
            ),
          );
        }),
        h('div', { className: 'dshsc-caption' }, translate('footnote')),
        h(
          'button',
          {
            type: 'button',
            className: 'dshsc-reset',
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              resetDefaults();
            },
          },
          translate('reset'),
        ),
      );
    }

    // -------------------------------------------------------------- plumbing

    const CSS = `
.dshsc-dragging { opacity: .55; }
body.dshsc-drag-active { user-select: none; cursor: grabbing; }
.dshsc-menu { order: -1; display: flex; flex-direction: column; gap: 2px; padding: 2px; min-width: 220px; max-width: 260px; font-size: var(--dshsc-menu-font, inherit); }
/* 弹层是外壳的：我们只挂一个 class 上去，把里面各行的字号也拉齐到侧栏那档
   （外壳自己的行写死了 13px，跟我们的行并排会一高一低）。这个 class 只在读到
   侧栏实际字号时才挂，所以这里不需要兜底值。 */
.dshsc-host-menu button { font-size: var(--dshsc-menu-font); }
.dshsc-caption { padding: 6px 10px 2px; font-size: .86em; opacity: .62; line-height: 1.2; }
.dshsc-row { display: flex; align-items: center; gap: 4px; border-radius: 6px; cursor: grab; }
.dshsc-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.dshsc-label { flex: 1; min-width: 0; text-align: left; background: none; border: none; color: inherit; font: inherit; padding: 6px 10px; cursor: pointer; border-radius: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshsc-toggle { flex: none; width: 24px; height: 24px; margin-right: 4px; border-radius: 6px; border: none; background: none; color: inherit; cursor: pointer; opacity: .5; font-size: .86em; }
.dshsc-toggle.is-on { opacity: 1; }
.dshsc-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18)); opacity: 1; }
.dshsc-reset { margin: 4px 6px 6px; padding: 6px 10px; border-radius: 6px; border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3)); background: none; color: inherit; font: inherit; font-size: .86em; opacity: .75; cursor: pointer; }
.dshsc-reset:hover { opacity: 1; }
`;

    function injectStyle() {
      if (styleTag !== null && document.head.contains(styleTag)) return;
      styleTag = document.createElement('style');
      styleTag.dataset.plugin = 'dsh-panel-compact';
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
    }

    function setupLocale(ctx) {
      const locale = ctx.locale;
      if (!locale || typeof locale.register !== 'function') return;
      try {
        locale.register(NS, { zh: ZH, en: EN });
      } catch {
        /* 下面再试一次按语言分开注册的写法 */
      }
      try {
        locale.register(NS, 'zh', ZH);
        locale.register(NS, 'en', EN);
      } catch {
        /* locale 是可选的，拿不到就用中文原串 */
      }
      if (typeof locale.bind === 'function') {
        try {
          translate = locale.bind(NS);
        } catch {
          /* 保持恒等翻译 */
        }
      }
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctxRef = ctx;
        try {
          injectStyle();
          setupLocale(ctx);
          load();
          refresh();
          save();
          watchNav();
          window.addEventListener('pointerdown', onPointerDown, true);
          window.setInterval(refresh, 2000);
          const stopFontWatch = watchFont();
          let unsubscribe = null;
          try {
            unsubscribe = ctx.slots.subscribe(PANEL_SLOT, () => refresh());
          } catch {
            /* 订阅不上还有 MutationObserver 与定时刷新兜底 */
          }
          if (typeof ctx.effect === 'function') {
            ctx.effect(
              () => () => {
                if (typeof unsubscribe === 'function') {
                  try {
                    unsubscribe();
                  } catch {
                    /* ignore */
                  }
                }
                window.removeEventListener('pointerdown', onPointerDown, true);
                stopFontWatch();
              },
              'dsh-panel-compact: listeners',
            );
          }
          // 「更多」菜单的内容由我们填充；外壳只在有插件注册时才会显示「更多」行。
          ctx.slots.inject(ACTIONS_SLOT, () =>
            ctx.slots.register(
              { name: ACTIONS_SLOT, id: 'dsh-panel-compact', order: 0, locale: NS },
              MorePanel,
            ),
          );
        } catch (failure) {
          // eslint-disable-next-line no-console -- 客户端激活失败否则无处可见
          console.error('[dsh-panel-compact] activation failed', (failure && failure.stack) || failure);
        }
      },
    };
  },
});
