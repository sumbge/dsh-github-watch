window.__ModuleLoader__.load({
  id: 'dsh-github-watch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const CSS = `.gw,.gw *,.gw *::before,.gw *::after{box-sizing:border-box}.gw{width:100%;max-width:880px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}.gw_head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.gw_title{font-size:15px;font-weight:600;line-height:22px}.gw_when{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}.gw_stats{display:flex;gap:8px;flex-wrap:wrap}.gw_stat{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:6px 12px;display:flex;flex-direction:column;gap:1px;min-width:74px}.gw_num{font-size:17px;font-weight:600;line-height:24px;font-variant-numeric:tabular-nums}.gw_lbl{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}.gw_stat.hot .gw_num{color:var(--dsw-alias-state-error-primary)}.gw_stat.good .gw_num{color:var(--dsw-alias-state-success-primary)}.gw_bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;row-gap:8px}.gw_search{flex:0 1 220px;min-width:0;max-width:220px}.gw_bar>.gw_btn{flex:none;white-space:nowrap}.gw_bar>.gw_when{flex:none;margin-left:auto}.gw_search input{width:100%;height:32px;font:inherit;font-size:13px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none}.gw_search input::placeholder{color:var(--dsw-alias-label-tertiary)}.gw_search input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}.gw_btn{cursor:pointer;font-size:12px;line-height:18px;padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}.gw_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.gw_btn:disabled{opacity:.5;cursor:default}.gw_list{display:flex;flex-direction:column;gap:6px}.gw_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:9px;padding:9px 12px}.gw_dot{width:7px;height:7px;border-radius:999px;flex:none;background:var(--dsw-alias-label-tertiary)}.gw_dot.updated{background:var(--dsw-alias-state-error-primary)}.gw_dot.current{background:var(--dsw-alias-state-success-primary)}.gw_dot.upstream{background:var(--dsw-alias-state-business-primary)}.gw_dot.removed{background:var(--dsw-alias-label-tertiary)}.gw_dot.vanished{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}.gw_status.removed{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}.gw_status.vanished{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary))}.gw_row.isremoved{opacity:.6}.gw_name{font-size:13px;line-height:20px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gw_kind{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1);border-radius:5px;padding:1px 7px;flex:none}.gw_status{font-size:12px;line-height:18px;flex:none;white-space:nowrap}.gw_status.updated{color:var(--dsw-alias-state-error-primary)}.gw_status.current{color:var(--dsw-alias-state-success-primary)}.gw_status.upstream{color:var(--dsw-alias-state-business-primary)}.gw_status.gone{color:var(--dsw-alias-label-tertiary)}.gw_detail{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);width:100%;word-break:break-all}.gw_row.hasdesc{align-items:flex-start}.gw_desc{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);width:100%;padding-top:2px;border-top:1px solid var(--dsw-alias-border-l2);margin-top:2px;word-break:break-word}.gw_more{cursor:pointer;font:inherit;font-size:11px;line-height:16px;padding:0 6px;margin-left:6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-state-business-primary);vertical-align:baseline}.gw_more:hover{background:var(--dsw-alias-interactive-bg-hover)}.gw_moreText{color:var(--dsw-alias-label-tertiary)}.gw_section{display:flex;flex-direction:column;gap:8px}.gw_sectHead{display:flex;align-items:baseline;gap:8px;padding:6px 2px 0}.gw_sectTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary)}.gw_sectCount{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}.gw_slug{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);text-decoration:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.gw_emptySmall{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:10px 4px}.gw_size{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none;background:var(--dsw-alias-bg-layer-1);border-radius:5px;padding:1px 7px}.gw_sizeDeps{color:var(--dsw-alias-label-tertiary)}.gw_depBox{width:100%;margin-top:6px;padding:8px 10px;border-top:1px dashed var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1);border-radius:8px}.gw_depPath{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-all}.gw_depList{display:flex;flex-direction:column;gap:4px}.gw_dep{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:18px}.gw_dep.miss{opacity:.5}.gw_depName{color:var(--dsw-alias-label-primary);flex:none;min-width:150px}.gw_depWhy{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;flex:1;min-width:0}.gw_depTag{flex:none;font-size:10px;line-height:14px;color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}.gw_depSize{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:11px}.gw_work{border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px;display:flex;flex-direction:column;gap:4px}.gw_workHead{display:flex;align-items:baseline;gap:8px}.gw_workTitle{font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-state-error-primary)}.gw_workSize{font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);margin-left:auto}.gw_depMini{padding-left:14px}.gw_dot.muted{background:var(--dsw-alias-label-tertiary);opacity:.7}.gw_status.muted{color:var(--dsw-alias-label-tertiary)}.gw_row.ismuted{opacity:.75}.gw_tab.active .gw_tabCount{color:var(--dsw-alias-label-secondary)}.gw_tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:6px}.gw_tab{cursor:pointer;font:inherit;font-size:13px;line-height:20px;padding:5px 12px;border-radius:8px 8px 0 0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:6px}.gw_tab:hover{background:var(--dsw-alias-interactive-bg-hover)}.gw_tab.active{color:var(--dsw-alias-label-primary);font-weight:600;background:var(--dsw-alias-bg-layer-3);box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary)}.gw_tabCount{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}.gw_check{flex:none;width:14px;height:14px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-business-primary)}.gw_check.gap{visibility:hidden}.gw_row.picked{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 6%,transparent)}.gw_selectBar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.gw_selectAll{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary)}.gw_selectAll input{accent-color:var(--dsw-alias-state-business-primary)}.gw_selCount{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:auto;font-variant-numeric:tabular-nums}.gw_btnDanger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}.gw_btnDanger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}.gw_btnDangerSolid{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}.gw_notice{font-size:12px;line-height:18px;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);cursor:pointer;word-break:break-word}.gw_overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:1000}.gw_dialog{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-shadow-lv1);padding:18px;max-width:520px;width:100%;display:flex;flex-direction:column;gap:12px}.gw_dialogTitle{font-size:15px;font-weight:600;line-height:22px}.gw_dialogBody{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.gw_dialogList{display:flex;flex-direction:column;gap:10px;max-height:50vh;overflow:auto}.gw_dialogItem{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px}.gw_dialogName{font-size:13px;font-weight:600}.gw_dialogBreak{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}.gw_dialogWarn{font-size:11px;color:var(--dsw-alias-state-error-primary);font-weight:600}.gw_dialogOk{font-size:11px;color:var(--dsw-alias-state-success-primary)}.gw_dialogActions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}.gw_sectTitle.gw_newTitle{color:var(--dsw-alias-state-error-primary)}.gw_queueHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:0 2px 2px}.gw_row.gw_new{border-color:var(--dsw-alias-state-error-primary);border-style:dashed}.gw_sectTitle.gw_discTitle{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary))}.gw_row.gw_disc{border-color:var(--dsw-alias-state-business-primary);border-style:dotted}.gw_want{width:100%;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent);border-left:2px solid var(--dsw-alias-state-business-primary);border-radius:4px;padding:3px 8px;word-break:break-word}.gw_btnScan{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.gw_btnScan:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}.gw_scanBar{position:relative;height:26px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);overflow:hidden;display:flex;align-items:center}.gw_scanFill{position:absolute;left:0;top:0;bottom:0;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent);transition:width .4s ease}.gw_scanText{position:relative;font-size:11px;line-height:16px;padding:0 10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}.gw_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:22px 4px;text-align:center}.gw_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.gw_copyTag{flex:none;font-size:10px;line-height:16px;padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}.gw_copies{margin-bottom:6px}.gw_copiesHead{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}`;

    const zh = {
      label: '已下载项目',
      title: '本机 GitHub 项目',
      refresh: '刷新',
      busy: '读取中…',
      filter: '筛选项目名或说明…',
      never: '尚未运行',
      dataAt: '数据时间',
      total: '项目',
      statProjects: '项目',
      statPlugins: '插件',
      secProjects: '项目',
      secPlugins: '插件',
      secTools: '工具',
      statTools: '工具',
      toolsTotal: '工具合计',
      secQueue: '待确认（别的对话刚下载的）',
      queueHint: '这些是其他会话按 ~/.agents/AGENTS.md 登记的下载记录。确认要长期跟踪，就把它加进 inventory.json。',
      statPending: '待确认',
      pending: '待确认',
      wantLabel: '当时的需求：',
      secDiscovered: '磁盘上有、没人登记过',
      discoveredHint: '扫描器找到的、但人工清单和下载登记里都没有的项目。出现这一区说明某次下载没有被记录，或者你就想留着自己看。',
      unlogged: '未登记',
      noRemote: '（无 remote）',
      secMuted: '已屏蔽',
      muteSelected: '屏蔽所选',
      muting: '屏蔽中…',
      unmuteSelected: '取消屏蔽',
      unmuting: '取消中…',
      mutedDone: '已屏蔽 {n} 项',
      unmutedDone: '已取消屏蔽 {n} 项',
      muteFailed: '屏蔽失败：{why}',
      noMuted: '没有屏蔽的项目',
      selectAll: '全选',
      unselectAll: '取消全选',
      selectOne: '勾选这一项',
      selectedN: '已选 {n} 项',
      noneSelected: '未选择',
      updateSelected: '更新所选',
      updating: '更新中…',
      deleteSelected: '删除所选',
      reinstallable: '可重下',
      customEdited: '本机改过',
      workOutput: '作业产出',
      confirmDeleteTitle: '确认删除 {n} 个项目',
      confirmDeleteBody: '删除不可逆。下面按「能不能重新拿回来」分开列。',
      confirmDelete: '确认删除',
      cancel: '取消',
      deleteDone: '已删除 {n} 项，释放 {mb} MB',
      deletePartial: '成功 {ok} 项，失败 {fail} 项：{why}',
      updateChanged: '已更新 {n} 项',
      updateSame: '{n} 项已是最新',
      updateFailed: '{n} 项无法更新：{why}',
      updateNothing: '没有任何变化',
      removedLabel: '已卸载',
      vanishedLabel: '目录不见了',
      scan: '扫描',
      scanning: '扫描中',
      scanHint: '重新扫描磁盘，发现新下载的项目并检查上游更新，约需 40 秒',
      noneMatch: '没有匹配的条目',
      sizeHint: '括号里是本体的体积，不含依赖',
      localBuild: '本机自建',
      workTitle: '作业产出（删了无法重来）',
      alsoAt: '另有克隆：',
      copiesTitle: '本地其他副本',
      copiesHint: '同一插件在磁盘上还有别的副本，这一行显示的是版本最新的那份',
      outdated: '有更新',
      current: '已最新',
      failed: '失败',
      loadFailed: '读取失败',
      expand: '展开',
      collapse: '收起',
      empty: '暂无报告。计划任务每天 09:30 运行，或手动执行 github-watch\\run.bat',
    };
    const en = {
      label: 'Local projects',
      title: 'Local GitHub projects',
      refresh: 'Refresh',
      busy: 'Loading…',
      filter: 'Filter by name or note…',
      never: 'never run',
      dataAt: 'Data from',
      total: 'projects',
      statProjects: 'projects',
      statPlugins: 'plugins',
      secProjects: 'Projects',
      secPlugins: 'Plugins',
      secTools: 'Tools',
      statTools: 'tools',
      toolsTotal: 'tools total',
      secQueue: 'Reported by other sessions',
      queueHint: 'Downloaded and logged via ~/.agents/AGENTS.md. Add one to inventory.json to track it.',
      statPending: 'pending',
      pending: 'pending',
      wantLabel: 'wanted:',
      secDiscovered: 'On disk, never logged',
      discoveredHint: 'Found by the scanner but absent from both the curated list and the download log. If this section appears, a download went unrecorded — or you meant to keep it untracked.',
      unlogged: 'unlogged',
      noRemote: '(no remote)',
      secMuted: 'Muted',
      muteSelected: 'Mute selected',
      muting: 'Muting…',
      unmuteSelected: 'Unmute',
      unmuting: 'Unmuting…',
      mutedDone: '{n} muted',
      unmutedDone: '{n} unmuted',
      muteFailed: 'Mute failed: {why}',
      noMuted: 'nothing muted',
      selectAll: 'Select all',
      unselectAll: 'Clear',
      selectOne: 'Tick this row',
      selectedN: '{n} selected',
      noneSelected: 'none selected',
      updateSelected: 'Update selected',
      updating: 'Updating…',
      deleteSelected: 'Delete selected',
      reinstallable: 're-downloadable',
      customEdited: 'edited locally',
      workOutput: 'your output',
      confirmDeleteTitle: 'Delete {n} project(s)?',
      confirmDeleteBody: 'Deletion cannot be undone. Bytes are split by whether they can be fetched again.',
      confirmDelete: 'Delete',
      cancel: 'Cancel',
      deleteDone: 'Deleted {n}, freed {mb} MB',
      deletePartial: '{ok} ok, {fail} failed: {why}',
      updateChanged: '{n} updated',
      updateSame: '{n} already current',
      updateFailed: '{n} could not update: {why}',
      updateNothing: 'nothing changed',
      removedLabel: 'uninstalled',
      vanishedLabel: 'directory gone',
      scan: 'Scan',
      scanning: 'Scanning',
      scanHint: 'Walk the disk again to find new downloads and check upstream, takes ~40 s',
      noneMatch: 'nothing matches',
      sizeHint: 'figure in brackets is the project itself, excluding dependencies',
      localBuild: 'local build',
      workTitle: 'Work output — cannot be re-downloaded',
      alsoAt: 'also cloned at:',
      copiesTitle: 'other local copies',
      copiesHint: 'this plugin exists in more than one place on disk; the row shows the newest version',
      outdated: 'outdated',
      current: 'current',
      failed: 'failed',
      loadFailed: 'Failed to load',
      expand: 'more',
      collapse: 'less',
      empty: 'No report yet. The task runs daily at 09:30, or run github-watch\\run.bat',
    };

    /**
     * Dot/colour class for a row.
     *
     * A row's `state` outranks its status text: `removed` is a decision and gets
     * the calm "done" colour, while `vanished` is an unknown and must not look
     * like either a success or a routine check failure.
     */
    function statusClass(row) {
      const state = row && row.state;
      if (state === 'removed') return 'removed';
      if (state === 'vanished') return 'vanished';
      if (state === 'muted') return 'muted';
      const status = (row && row.status) || '';
      if (status.indexOf('有更新') >= 0) return 'updated';
      if (status.indexOf('最新') >= 0) return 'current';
      if (status.indexOf('上游有') >= 0) return 'upstream';
      if (status.indexOf('下架') >= 0 || status.indexOf('无上游') >= 0) return 'gone';
      if (status.indexOf('失败') >= 0 || status.indexOf('不见了') >= 0) return 'failed';
      return '';
    }

    /** Bytes -> human text. Below a megabyte show KB: "0 MB" reads as nothing. */
    function fmtBytes(b) {
      const n = Number(b) || 0;
      if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
      if (n >= 1048576) return Math.round(n / 1048576) + ' MB';
      if (n >= 1024) return Math.round(n / 1024) + ' KB';
      return n + ' B';
    }

    /** MB -> "2.9 GB" past a thousand, "534 MB" below. Fixed one decimal. */
    function fmtMb(mb) {
      const n = Number(mb) || 0;
      if (n >= 1000) return (n / 1024).toFixed(1) + ' GB';
      if (n >= 1) return Math.round(n) + ' MB';
      return n > 0 ? n.toFixed(1) + ' MB' : '—';
    }

    function Watch() {
      const t = Watch.t;
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [filter, setFilter] = useState('');
      // Fold state is per row and lives here rather than in each row component:
      // keyed by "project#index" so it survives a re-render after refresh, and
      // opening one row must not collapse another.
      const [expanded, setExpanded] = useState({});

      const load = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
          const res = await fetch('/github-watch/api/projects', { headers: { accept: 'application/json' } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          setData(await res.json());
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      // Scan state. POST returns immediately and the pipeline runs in the host
      // process, so the button cannot show a spinner tied to one fetch: it polls
      // until the host says it is done, then reloads the data underneath.
      const [scan, setScan] = useState({ running: false, step: '', stepIndex: 0, totalSteps: 3, error: '' });

      const pollScan = useCallback(async () => {
        try {
          const res = await fetch('/github-watch/api/scan', { headers: { accept: 'application/json' } });
          if (!res.ok) return;
          const st = await res.json();
          setScan(st);
          if (!st.running) {
            if (st.error) setError(st.error);
            load();                       // pull the fresh inventory + report
          }
          return st;
        } catch {
          return null;
        }
      }, [load]);

      const startScan = useCallback(async () => {
        setError('');
        try {
          const res = await fetch('/github-watch/api/scan', { method: 'POST', headers: { accept: 'application/json' } });
          const st = await res.json();
          if (st.started === false) return;   // already running, the poll will show it
          setScan({ running: true, step: '', stepIndex: 0, totalSteps: 3, error: '' });
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        }
      }, []);

      // Poll every 1.5 s while a scan is in flight. Cleared on unmount so a
      // closed Settings page does not keep hitting the host.
      useEffect(() => {
        if (!scan.running) return undefined;
        const timer = setInterval(() => { pollScan(); }, 1500);
        return () => clearInterval(timer);
      }, [scan.running, pollScan]);

      // A scan started in another tab (or before this page opened) is picked up
      // here, so the button reflects reality rather than only local clicks.
      useEffect(() => { pollScan(); }, [pollScan]);

      const projects = (data && data.projects) || [];
      const plugins = (data && data.plugins) || [];
      const q = filter.trim().toLowerCase();
      const match = (r) => !q || (r.name + ' ' + r.detail + ' ' + r.slug).toLowerCase().indexOf(q) >= 0;
      // Sorted so an uninstalled project sinks to the bottom: it is history, and
      // keeping it in rank order would put a crossed-out row among the live ones.
      const sink = (a, b) => (a.state === 'removed' ? 1 : 0) - (b.state === 'removed' ? 1 : 0);
      // Muting must remove a row from the main list, not just grey it out. The
      // point of muting is to stop having to look at it; a muted row that stays
      // in "项目" is still in the way, and its presence made the tab counts lie
      // (8 projects of which 1 was parked). Muted rows live in their own tab and
      // nowhere else.
      const active = (r) => r.state !== 'muted';
      const shownProjects = projects.filter(match).filter(active).sort(sink);
      const shownPlugins = plugins.filter(match).filter(active).sort(sink);
      const counts = (data && data.counts) || {};
      const when = (data && (data.generatedAt || (data.lastRun && data.lastRun.at))) || '';

      // -- selection ---------------------------------------------------------
      // Keyed by name, not index: a scan reorders rows (a project that gains an
      // update moves up), and a selection that followed the index would silently
      // start pointing at different projects than the ones ticked.
      // Declared before the selection block: `selectable` depends on which tab
      // is showing, so the tab has to exist first (a const read in its own TDZ
      // throws, unlike a function body that runs later).
      const [tab, setTab] = useState('project');
      // Muted rows live in their own tab and nowhere else: they are still
      // projects the operator owns, so they are not deleted, but they are kept
      // out of the lists that are supposed to need attention.
      const mutedRows = [...projects, ...plugins].filter((r) => r.state === 'muted');

      const [selected, setSelected] = useState({});
      const [busy2, setBusy2] = useState('');
      const [dialog, setDialog] = useState(null);   // delete confirmation
      const [notice, setNotice] = useState('');

      // Selection follows the tab. It used to be fixed to projects+plugins, so
      // ticking a row in the muted tab updated nothing and "select all" reached
      // past the visible list — the buttons then acted on rows the operator
      // could not see. `tab` is declared below; this is a plain function so the
      // forward reference is fine at call time.
      const selectableFor = (which) => {
        if (which === 'muted') return mutedRows;
        if (which === 'tool') return [];
        return [...shownProjects, ...shownPlugins];
      };
      const selectable = selectableFor(tab);
      const selectedNames = Object.keys(selected).filter((n) => selected[n]);
      const allOn = selectable.length > 0 && selectable.every((r) => selected[r.name]);
      const toggleOne = (name) => setSelected((s) => ({ ...s, [name]: !s[name] }));
      const toggleAll = () => {
        const next = {};
        for (const r of selectable) next[r.name] = !allOn;
        setSelected(next);
      };

      /**
       * Deletion is two steps on purpose.
       *
       * Step one asks the host what would be lost, per project, and shows the
       * three kinds of bytes separately. A single "delete 3 projects (3.2 GB)"
       * dialog hides the only thing that matters: which of those gigabytes the
       * operator could not get back.
       */
      const confirmDelete = useCallback(async (names) => {
        setBusy2('preview');
        try {
          const previews = [];
          for (const n of names) {
            const res = await fetch('/github-watch/api/preview-delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: n }),
            });
            previews.push(await res.json());
          }
          setDialog({ names, previews });
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy2('');
        }
      }, []);

      const runDelete = useCallback(async (names) => {
        setBusy2('delete');
        setDialog(null);
        try {
          const res = await fetch('/github-watch/api/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ names }),
          });
          const out = await res.json();
          const failed = (out.results || []).filter((r) => !r.ok);
          const freedB = (out.results || []).filter((r) => r.ok)
            .reduce((n, r) => n + (r.freedBytes || 0), 0);
          setNotice(failed.length
            ? t('deletePartial').replace('{ok}', String((out.results || []).length - failed.length))
                .replace('{fail}', String(failed.length))
                .replace('{why}', failed.map((f) => f.error).join('；').slice(0, 160))
            : t('deleteDone').replace('{n}', String((out.results || []).length))
                .replace('{mb}', fmtBytes(freedB)));
          setSelected({});
          load();
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy2('');
        }
      }, [load]);

      /**
       * Mute/unmute. Same shape as delete but reversible, so it fires at once
       * with no dialog: the cost of a mistaken click is one more click, and a
       * confirmation here would train the operator to dismiss dialogs unread.
       */
      const runMute = useCallback(async (names, muted) => {
        setBusy2(muted ? 'mute' : 'unmute');
        try {
          const res = await fetch('/github-watch/api/mute', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ names, muted }),
          })
          const out = await res.json();
          const bad = (out.results || []).filter((r) => !r.ok);
          // No notice on success: the row leaves this tab and appears in the
          // other one, which is louder than any toast. Only a failure needs
          // saying, because nothing visible changed to explain it. (A "已屏蔽 1 项"
          // banner used to sit there pointing at a row that had already moved.)
          if (bad.length) {
            setNotice(t('muteFailed').replace('{why}', bad.map((b) => b.error).join('；').slice(0, 160)));
          }
          setSelected({});
          load();
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy2('');
        }
      }, [load]);

      const runUpdate = useCallback(async (names) => {
        setBusy2('update');
        try {
          const res = await fetch('/github-watch/api/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ names }),
          });
          const out = await res.json();
          const ok = (out.results || []).filter((r) => r.ok);
          const bad = (out.results || []).filter((r) => !r.ok);
          const changed = ok.filter((r) => r.changed);
          const parts = [];
          if (changed.length) parts.push(t('updateChanged').replace('{n}', String(changed.length)));
          if (ok.length - changed.length) parts.push(t('updateSame').replace('{n}', String(ok.length - changed.length)));
          if (bad.length) parts.push(t('updateFailed').replace('{n}', String(bad.length))
            .replace('{why}', bad.map((b) => `${b.name || ''}: ${b.error || ''}`).join('；').slice(0, 200)));
          setNotice(parts.join(' ｜ ') || t('updateNothing'));
          load();
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy2('');
        }
      }, [load]);

      const stat = (cls, num, label) => h('div', { className: 'gw_stat ' + cls },
        h('div', { className: 'gw_num' }, num == null ? '–' : num),
        h('div', { className: 'gw_lbl' }, label));

      // One row renderer for both sections: the only difference is that a plugin
      // shows its version where a project shows its kind.
      const rowOf = (r, i, section) => {
        const cls = statusClass(r);
        const key = section + ':' + r.name + '#' + i;
        const open = Boolean(expanded[key]);
        const lead = section === 'plugin' ? (r.version ? 'v' + r.version : '') : r.kind;
        const hasDeps = (r.deps || []).length > 0;
        const hasWork = Boolean(r.work);
        // The size cell is the reason this list exists: sorted by eye, it answers
        // "what is eating the disk". Reported with the dependency total in
        // parentheses because "rea 2.9 GB" is really "535 MB of rea".
        const size = r.sizeMb ? h('span', { className: 'gw_size', title: t('sizeHint') },
          fmtMb(r.sizeMb),
          hasDeps ? h('span', { className: 'gw_sizeDeps' }, ' (' + fmtMb(r.own_mb || 0) + ')') : null) : null;

        const details = open ? h('div', { className: 'gw_depBox' },
          r.path ? h('div', { className: 'gw_depPath' }, r.path) : null,
          // Extra copies of the same plugin on disk. Only the newest is listed as
          // the plugin itself, so without this the others are invisible — and one
          // of them is often an older version some agent left behind.
          r.copies && r.copies.length
            ? h('div', { className: 'gw_copies' },
              h('div', { className: 'gw_copiesHead' },
                h('span', { className: 'gw_workTitle' }, t('copiesTitle')),
                h('span', { className: 'gw_workSize' }, String(r.copies.length))),
              r.copies.map((c, j) => h('div', { className: 'gw_dep gw_depMini', key: 'c' + j },
                h('span', { className: 'gw_depName' }, c.version ? 'v' + c.version : '—'),
                h('span', { className: 'gw_depWhy' }, c.profile || ''),
                h('span', { className: 'gw_depSize' }, c.path))))
            : null,
          hasDeps ? h('div', { className: 'gw_depList' },
            (r.deps || []).map((d, j) => h('div', { className: 'gw_dep' + (d.exists === false ? ' miss' : ''), key: 'd' + j },
              h('span', { className: 'gw_depName' }, d.name),
              h('span', { className: 'gw_depWhy' }, d.why),
              d.local ? h('span', { className: 'gw_depTag' }, t('localBuild')) : null,
              h('span', { className: 'gw_depSize' }, fmtMb(d.sizeMb))))) : null,
          hasWork ? h('div', { className: 'gw_work' },
            h('div', { className: 'gw_workHead' },
              h('span', { className: 'gw_workTitle' }, t('workTitle')),
              h('span', { className: 'gw_workSize' }, fmtMb(r.workMb))),
            h('div', { className: 'gw_depWhy' }, r.work.why || ''),
            (r.work.items || []).map((it, j) => h('div', { className: 'gw_dep gw_depMini', key: 'w' + j },
              h('span', { className: 'gw_depName' }, it.name),
              h('span', { className: 'gw_depSize' }, fmtMb(it.sizeMb))))) : null,
          r.aliases && r.aliases.length
            ? h('div', { className: 'gw_depWhy' }, t('alsoAt') + ' ' + r.aliases.join('、'))
            : null) : null;

        const foldable = Boolean(r.descriptionRest) || hasDeps || hasWork;
        // Uninstalled rows cannot be selected: there is nothing left to delete or
        // update, and offering the checkbox invites a no-op that looks like work.
        const canPick = r.state !== 'removed';
        return h('div', { className: 'gw_row' + (r.description ? ' hasdesc' : '') + (open ? ' open' : '') + (r.state === 'removed' ? ' isremoved' : '') + (r.state === 'muted' ? ' ismuted' : '') + (selected[r.name] ? ' picked' : ''), key },
          canPick
            ? h('input', {
              type: 'checkbox',
              className: 'gw_check',
              checked: Boolean(selected[r.name]),
              onChange: () => toggleOne(r.name),
              title: t('selectOne'),
            })
            : h('span', { className: 'gw_check gap' }),
          h('span', { className: 'gw_dot ' + cls }),
          h('span', { className: 'gw_name' }, r.name),
          r.copies && r.copies.length
            ? h('span', { className: 'gw_copyTag', title: t('copiesHint') }, '+' + r.copies.length)
            : null,
          lead ? h('span', { className: 'gw_kind' }, lead) : null,
          h('span', { className: 'gw_status ' + cls }, r.status),
          size,
          r.slug ? h('span', { className: 'gw_slug' }, r.slug) : null,
          r.detail ? h('span', { className: 'gw_detail' }, r.detail) : null,
          r.description
            ? h('span', { className: 'gw_desc' },
              r.description,
              r.descriptionRest && !open
                ? h('span', { className: 'gw_moreText' }, '…')
                : null,
              foldable
                ? h('button', {
                  className: 'gw_more',
                  onClick: () => setExpanded((prev) => ({ ...prev, [key]: !prev[key] })),
                  title: open ? t('collapse') : t('expand'),
                }, open ? t('collapse') : t('expand'))
                : null)
            : null,
          details);
      };

      /** Render a tab's list body only — the heading becomes the tab itself. */
      const sectionBody = (rows, kind) => (
        rows.length === 0
          ? h('div', { className: 'gw_emptySmall' }, t('noneMatch'))
          : h('div', { className: 'gw_list' }, rows.map((r, i) => rowOf(r, i, kind))));

      const toolRow = (r, i) => h('div', { className: 'gw_row', key: 'tool' + i },
        h('span', { className: 'gw_dot ' + (r.status === '已安装' ? 'current' : 'gone') }),
        h('span', { className: 'gw_name' }, r.name),
        h('span', { className: 'gw_kind' }, 'v' + r.version),
        h('span', { className: 'gw_status ' + (r.status === '已安装' ? 'current' : 'gone') }, r.status),
        h('span', { className: 'gw_size' }, fmtMb(r.sizeMb)),
        r.slug ? h('span', { className: 'gw_slug' }, r.slug) : null,
        r.why ? h('span', { className: 'gw_detail' }, r.why) : null,
        r.path ? h('span', { className: 'gw_detail' }, r.path) : null);

      const tools = (data && data.tools) || [];
      const shownTools = tools.filter((r) => !q || (r.name + ' ' + r.why).toLowerCase().indexOf(q) >= 0);

      // Which list is showing. Projects and plugins used to stack, so reaching
      // the plugins meant scrolling past eight project rows — the plugins were
      // invisible unless you already knew to look. A tab makes both one click
      // away and keeps the panel height fixed.
      //
      // The selection is NOT cleared on tab switch: ticking three projects,
      // peeking at plugins, then coming back and finding nothing selected would
      // be a small betrayal every time.
      const tabs = h('div', { className: 'gw_tabs' },
        h('button', {
          className: 'gw_tab' + (tab === 'project' ? ' active' : ''),
          onClick: () => setTab('project'),
        }, t('secProjects'), h('span', { className: 'gw_tabCount' }, shownProjects.length)),
        h('button', {
          className: 'gw_tab' + (tab === 'plugin' ? ' active' : ''),
          onClick: () => setTab('plugin'),
        }, t('secPlugins'), h('span', { className: 'gw_tabCount' }, shownPlugins.length)),
        h('button', {
          className: 'gw_tab' + (tab === 'tool' ? ' active' : ''),
          onClick: () => setTab('tool'),
        }, t('secTools'), h('span', { className: 'gw_tabCount' }, shownTools.length)),
        h('button', {
          className: 'gw_tab' + (tab === 'muted' ? ' active' : ''),
          onClick: () => setTab('muted'),
        }, t('secMuted'), h('span', { className: 'gw_tabCount' }, mutedRows.length)));

      const tabBody = tab === 'project'
        ? sectionBody(shownProjects, 'project')
        : tab === 'plugin'
          ? sectionBody(shownPlugins, 'plugin')
          : tab === 'muted'
            ? (mutedRows.length === 0
                ? h('div', { className: 'gw_emptySmall' }, t('noMuted'))
                : h('div', { className: 'gw_list' }, mutedRows.map((r, i) => rowOf(r, i, 'muted'))))
            : shownTools.length === 0
              ? h('div', { className: 'gw_emptySmall' }, t('noneMatch'))
              : h('div', { className: 'gw_list' }, shownTools.map(toolRow));
      const toolTotal = tools.reduce((n, r) => n + (r.sizeMb || 0), 0);

      // Two different kinds of "not curated yet", kept apart on purpose:
      //   queue      — a session reported it; we know why it was fetched
      //   discovered — the disk scan found it and nothing reported it; nobody
      //                knows why. The second is the one that catches a session
      //                that ignored the logging rule, so it must stay visible.
      const discovered = (data && data.discovered) || [];
      const shownDiscovered = discovered.filter((r) => !q || (r.name + ' ' + r.path).toLowerCase().indexOf(q) >= 0);

      const discoveredSection = shownDiscovered.length === 0 ? null : h('div', { className: 'gw_section' },
        h('div', { className: 'gw_sectHead' },
          h('span', { className: 'gw_sectTitle gw_discTitle' }, t('secDiscovered')),
          h('span', { className: 'gw_sectCount' }, shownDiscovered.length)),
        h('div', { className: 'gw_queueHint' }, t('discoveredHint')),
        h('div', { className: 'gw_list' }, shownDiscovered.map((r, i) => h('div', { className: 'gw_row gw_disc', key: 'd' + i },
          h('span', { className: 'gw_dot upstream' }),
          h('span', { className: 'gw_name' }, r.name),
          h('span', { className: 'gw_kind' }, r.kind),
          h('span', { className: 'gw_status upstream' }, t('unlogged')),
          h('span', { className: 'gw_size' }, fmtMb(r.sizeMb)),
          r.slug ? h('span', { className: 'gw_slug' }, r.slug) : h('span', { className: 'gw_slug' }, t('noRemote')),
          r.path ? h('span', { className: 'gw_detail' }, r.path) : null,
          r.description ? h('span', { className: 'gw_desc' }, r.description) : null))))

      // Reported by other sessions through ~/.agents/AGENTS.md — downloaded but
      // not yet accepted into inventory.json. Shown first and highlighted,
      // because a row here means "something arrived that you did not curate".
      const queue = (data && data.queue) || [];
      const queueSection = queue.length === 0 ? null : h('div', { className: 'gw_section' },
        h('div', { className: 'gw_sectHead' },
          h('span', { className: 'gw_sectTitle gw_newTitle' }, t('secQueue')),
          h('span', { className: 'gw_sectCount' }, queue.length)),
        h('div', { className: 'gw_queueHint' }, t('queueHint')),
        h('div', { className: 'gw_list' }, queue.map((r, i) => h('div', { className: 'gw_row gw_new', key: 'q' + i },
          h('span', { className: 'gw_dot updated' }),
          h('span', { className: 'gw_name' }, r.name),
          r.method ? h('span', { className: 'gw_kind' }, r.method) : null,
          h('span', { className: 'gw_status updated' }, t('pending')),
          r.version ? h('span', { className: 'gw_size' }, r.version) : null,
          r.slug ? h('span', { className: 'gw_slug' }, r.slug) : null,
          r.at ? h('span', { className: 'gw_when' }, r.at.replace('T', ' ').slice(0, 16)) : null,
          r.path ? h('span', { className: 'gw_detail' }, r.path) : null,
          r.want ? h('span', { className: 'gw_want' }, t('wantLabel') + ' ' + r.want) : null,
          r.note ? h('span', { className: 'gw_desc' }, r.note) : null))));

      return h('div', { className: 'gw' },
        h('style', null, CSS),
        h('div', { className: 'gw_head' },
          h('div', { className: 'gw_title' }, t('title')),
          h('div', { className: 'gw_when' }, when ? t('dataAt') + ' ' + when : t('never'))),
        error ? h('div', { className: 'gw_err' }, t('loadFailed') + ': ' + error) : null,
        h('div', { className: 'gw_stats' },
          stat('', projects.length, t('statProjects')),
          stat('', plugins.length, t('statPlugins')),
          stat('', tools.length, t('statTools')),
          queue.length ? stat('hot', queue.length, t('statPending')) : stat('hot', counts.updated, t('outdated'))),
        h('div', { className: 'gw_bar' },
          h('div', { className: 'gw_search' },
            h('input', {
              value: filter,
              placeholder: t('filter'),
              onChange: (e) => setFilter(e.target.value),
            })),
          h('button', {
            className: 'gw_btn gw_btnScan',
            onClick: startScan,
            disabled: scan.running,
            title: t('scanHint'),
          }, scan.running
            ? t('scanning') + (scan.step ? ' ' + scan.step : '')
            : t('scan')),
          h('button', { className: 'gw_btn', onClick: load, disabled: busy },
            busy ? t('busy') : t('refresh')),
          toolTotal ? h('span', { className: 'gw_when' },
            t('toolsTotal') + ' ' + fmtMb(toolTotal)) : null),
        // Selection bar. Only rendered once something is ticked or a selection
        // exists, so the default view stays quiet.
        selectable.length > 0
          ? h('div', { className: 'gw_selectBar' },
            h('label', { className: 'gw_selectAll' },
              h('input', { type: 'checkbox', checked: allOn, onChange: toggleAll }),
              h('span', null, allOn ? t('unselectAll') : t('selectAll'))),
            selectedNames.length > 0
              ? h('span', { className: 'gw_selCount' },
                t('selectedN').replace('{n}', String(selectedNames.length)))
              : h('span', { className: 'gw_selCount' }, t('noneSelected')),
            tab === 'muted'
              ? h('button', {
                className: 'gw_btn',
                disabled: selectedNames.length === 0 || Boolean(busy2),
                onClick: () => runMute(selectedNames, false),
              }, busy2 === 'unmute' ? t('unmuting') : t('unmuteSelected'))
              : h('button', {
                className: 'gw_btn',
                disabled: selectedNames.length === 0 || Boolean(busy2),
                onClick: () => runMute(selectedNames, true),
              }, busy2 === 'mute' ? t('muting') : t('muteSelected')),
            tab === 'muted'
              ? null
              : h('button', {
                className: 'gw_btn',
                disabled: selectedNames.length === 0 || Boolean(busy2),
                onClick: () => runUpdate(selectedNames),
              }, busy2 === 'update' ? t('updating') : t('updateSelected')),
            h('button', {
              className: 'gw_btn gw_btnDanger',
              disabled: selectedNames.length === 0 || Boolean(busy2),
              onClick: () => confirmDelete(selectedNames),
            }, t('deleteSelected')))
          : null,
        notice ? h('div', { className: 'gw_notice', onClick: () => setNotice('') }, notice) : null,
        scan.running
          ? h('div', { className: 'gw_scanBar' },
            h('div', {
              className: 'gw_scanFill',
              // `progress` is the host's weighted fraction, not steps done: the
              // three steps take 2 s / 1 s / 32 s, so a step counter would sit at
              // 100 % for most of the run and look frozen.
              style: { width: Math.max(3, Math.round((scan.progress || 0) * 100)) + '%' },
            }),
            h('span', { className: 'gw_scanText' },
              t('scanning') +
              (scan.sub && scan.sub.current
                ? ' ' + scan.sub.current + ' (' + scan.sub.done + '/' + scan.sub.total + ')'
                : scan.step ? ' ' + scan.step : '') +
              ' · ' + Math.round((scan.progress || 0) * 100) + '%'))
          : null,
        queueSection,
        discoveredSection,
        tabs,
        tabBody,
        // The confirm dialog. It exists because the numbers have to be in front
        // of the decision: "delete rea" and "delete 2.9 GB, of which 214 MB is
        // your own analysis output" are not the same request.
        dialog ? h('div', { className: 'gw_overlay', onClick: () => setDialog(null) },
          h('div', { className: 'gw_dialog', onClick: (e) => e.stopPropagation() },
            h('div', { className: 'gw_dialogTitle' },
              t('confirmDeleteTitle').replace('{n}', String(dialog.names.length))),
            h('div', { className: 'gw_dialogBody' }, t('confirmDeleteBody')),
            h('div', { className: 'gw_dialogList' },
              dialog.previews.map((p, i) => h('div', { className: 'gw_dialogItem', key: 'p' + i },
                p.ok
                  ? h('div', null,
                    h('div', { className: 'gw_dialogName' }, p.name + '  ·  ' + fmtBytes(p.totalBytes)),
                    h('div', { className: 'gw_dialogBreak' },
                      t('reinstallable') + ' ' + fmtMb(p.reinstallableMb),
                      p.customMb ? ' ｜ ' + t('customEdited') + ' ' + fmtMb(p.customMb) : '',
                      p.workMb ? ' ｜ ' + t('workOutput') + ' ' + fmtMb(p.workMb) : ''),
                    h('div', { className: p.workMb || p.customMb ? 'gw_dialogWarn' : 'gw_dialogOk' }, p.warning))
                  : h('div', { className: 'gw_dialogWarn' }, p.name + ': ' + p.error)))),
            h('div', { className: 'gw_dialogActions' },
              h('button', { className: 'gw_btn', onClick: () => setDialog(null) }, t('cancel')),
              h('button', {
                className: 'gw_btn gw_btnDangerSolid',
                onClick: () => runDelete(dialog.names),
              }, t('confirmDelete'))))) : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Effective text falls back to zh while the locale service reports no
        // bundle, so the page never renders raw keys if registration is late.
        ctx.effect(() => ctx.locale.register('github-watch', { zh, en }), 'github-watch: dictionaries');
        const translate = ctx.locale.bind('github-watch');
        Watch.t = (k) => {
          try {
            const v = translate(k);
            return v == null || v === k ? (zh[k] != null ? zh[k] : k) : v;
          } catch {
            return zh[k] != null ? zh[k] : k;
          }
        };
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'github-watch',
          order: 48,
          label: () => Watch.t('label'),
          locale: 'github-watch',
        }, Watch));
      },
    };
  },
});
