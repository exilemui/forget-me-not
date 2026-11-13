window.__ModuleLoader__.load({
  id: '@local/forget-me-not',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;

    const NS = 'forget-me-not';
    const PANEL_ID = 'forget-me-not';
    const API = '/api/forget-me-not/config';

    const zh = {
      nav: '勿忘我',
      settings: '设置',
      subtitle: '勿忘我 · forget-me-not',
      fieldAgentName: 'AI 的名字（你的智能体叫什么）',
      fieldUserName: '你的名字（怎么称呼你）',
      fieldLanguage: '语言',
      fieldEmbedModel: '向量模型',
      langZh: '中文',
      langEn: 'English',
      modelLight: '轻量（英文，约 23MB，下载快）',
      modelFull: '完全（多语言中英文，约 118MB，质量高）',
      placeholderEmpty: '留空',
      hintEmptyName: '留空表示不预设名字，靠对话时自然询问。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存（宿主会应用新配置，可刷新页面确认）',
      loading: '读取配置中…',
    };
    const en = {
      nav: 'forget-me-not',
      settings: 'Settings',
      subtitle: 'forget-me-not · 勿忘我',
      fieldAgentName: "AI's name (what to call your agent)",
      fieldUserName: 'Your name (what to call you)',
      fieldLanguage: 'Language',
      fieldEmbedModel: 'Embedding model',
      langZh: '中文',
      langEn: 'English',
      modelLight: 'Light (English, ~23MB, fast)',
      modelFull: 'Full (multilingual, ~118MB, higher quality)',
      placeholderEmpty: 'empty',
      hintEmptyName: 'Leave empty to not preset names — exchange them naturally in conversation.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved (the host will apply it; refresh to confirm)',
      loading: 'Loading config…',
    };

    function FlowerGlyph(size) {
      const s = size || 16;
      const petals = [0, 72, 144, 216, 288].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return h('circle', {
          key: deg,
          cx: 32 + 13 * Math.cos(rad),
          cy: 32 + 13 * Math.sin(rad),
          r: 9.5,
          fill: '#5b8fd6',
        });
      });
      return h('svg', {
        viewBox: '0 0 64 64',
        width: s,
        height: s,
        'aria-hidden': true,
        style: { display: 'block', pointerEvents: 'none' },
      }, petals, h('circle', { cx: 32, cy: 32, r: 5.5, fill: '#f2c14e' }));
    }

    const fieldStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      marginBottom: '14px',
      fontSize: '13px',
      color: 'var(--dsw-alias-text-secondary, inherit)',
    };
    const inputStyle = {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: '420px',
      padding: '8px 10px',
      fontSize: '14px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.35))',
      background: 'var(--dsw-alias-bg-input, transparent)',
      color: 'var(--dsw-alias-text-primary, inherit)',
    };

    // 自绘下拉：整个内容框都是点击热区（原生 select 在部分主题里只有箭头附近可点）。
    function Dropdown({ value, options, onChange }) {
      const [open, setOpen] = useState(false);
      const ref = useRef(null);

      useEffect(() => {
        if (!open) return;
        const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
      }, [open]);

      const current = options.find((o) => o.value === value) || options[0];
      const triggerStyle = {
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: '420px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 10px',
        fontSize: '14px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-input, transparent)',
        color: 'var(--dsw-alias-text-primary, inherit)',
        cursor: 'pointer',
        userSelect: 'none',
      };
      const menuStyle = {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        left: 0,
        right: 0,
        maxWidth: '420px',
        background: 'var(--dsw-alias-bg-elevated, #ffffff)',
        border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.35))',
        borderRadius: '6px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        zIndex: 20,
        maxHeight: '220px',
        overflowY: 'auto',
        margin: 0,
        padding: 0,
      };
      const optionStyle = (active) => ({
        padding: '8px 10px',
        cursor: 'pointer',
        fontSize: '14px',
        color: 'var(--dsw-alias-text-primary, inherit)',
        background: active ? 'var(--dsw-alias-bg-hover, rgba(0,0,0,0.06))' : 'transparent',
      });

      return h('div', { ref, style: { position: 'relative', width: '100%', maxWidth: '420px' } },
        h('button', {
          type: 'button',
          onClick: () => setOpen(!open),
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          style: triggerStyle,
        },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, current.label),
          h('span', { 'aria-hidden': true, style: { marginLeft: '10px', fontSize: '11px', color: 'var(--dsw-alias-text-tertiary, inherit)' } }, '▾')
        ),
        open ? h('div', { role: 'listbox', style: menuStyle },
          options.map((o) => h('div', {
            key: o.value,
            role: 'option',
            'aria-selected': o.value === value,
            onClick: () => { onChange(o.value); setOpen(false); },
            style: optionStyle(o.value === value),
          }, o.label))
        ) : null
      );
    }

    function ConfigForm({ t }) {
      const [config, setConfig] = useState(null);
      const [draft, setDraft] = useState(null);
      const [phase, setPhase] = useState('loading');
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState(null);

      useEffect(() => {
        let alive = true;
        fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => r.json())
          .then((body) => {
            if (!alive) return;
            if (body && body.ok) { setConfig(body.value); setDraft(body.value); setPhase('ready'); }
            else { setNotice({ kind: 'error', text: (body && body.error && body.error.message) || 'read failed' }); setPhase('error'); }
          })
          .catch((e) => { if (alive) { setNotice({ kind: 'error', text: String(e && e.message ? e.message : e) }); setPhase('error'); } });
        return () => { alive = false; };
      }, []);

      if (phase === 'loading') return h('p', { style: { fontSize: '13px', color: 'var(--dsw-alias-text-tertiary, inherit)' } }, t('loading'));
      if (phase === 'error') {
        return h('p', { style: { fontSize: '13px', color: 'var(--dsw-alias-danger, #c0392b)' } }, (notice && notice.text) || 'error');
      }

      const d = draft || {};
      const set = (k) => (e) => setDraft(Object.assign({}, d, { [k]: e.target.value }));

      const save = () => {
        setSaving(true);
        setNotice(null);
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(d),
        })
          .then((r) => r.json())
          .then((body) => {
            setSaving(false);
            if (body && body.ok) { setConfig(body.value); setDraft(body.value); setNotice({ kind: 'ok', text: t('saved') }); }
            else { setNotice({ kind: 'error', text: (body && body.error && body.error.message) || 'save failed' }); }
          })
          .catch((e) => { setSaving(false); setNotice({ kind: 'error', text: String(e && e.message ? e.message : e) }); });
      };

      const noticeColor = notice && notice.kind === 'ok'
        ? 'var(--dsw-alias-success, #27ae60)'
        : 'var(--dsw-alias-danger, #c0392b)';

      return h('div', { style: { maxWidth: '480px' } },
        h('div', { style: fieldStyle },
          h('span', null, t('fieldAgentName')),
          h('input', { type: 'text', value: d.agentName || '', onChange: set('agentName'), placeholder: t('placeholderEmpty'), style: inputStyle })
        ),
        h('div', { style: fieldStyle },
          h('span', null, t('fieldUserName')),
          h('input', { type: 'text', value: d.userName || '', onChange: set('userName'), placeholder: t('placeholderEmpty'), style: inputStyle })
        ),
        h('div', { style: fieldStyle },
          h('span', null, t('fieldLanguage')),
          h(Dropdown, {
            value: d.language || 'zh',
            onChange: (v) => setDraft(Object.assign({}, d, { language: v })),
            options: [
              { value: 'zh', label: t('langZh') },
              { value: 'en', label: t('langEn') },
            ],
          })
        ),
        h('div', { style: fieldStyle },
          h('span', null, t('fieldEmbedModel')),
          h(Dropdown, {
            value: d.embedModel || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
            onChange: (v) => setDraft(Object.assign({}, d, { embedModel: v })),
            options: [
              { value: 'Xenova/all-MiniLM-L6-v2', label: t('modelLight') },
              { value: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', label: t('modelFull') },
            ],
          })
        ),
        h('p', { style: { margin: '0 0 12px', fontSize: '12px', color: 'var(--dsw-alias-text-tertiary, inherit)' } }, t('hintEmptyName')),
        h('button', {
          onClick: save,
          disabled: saving,
          style: {
            padding: '8px 18px',
            fontSize: '14px',
            borderRadius: '6px',
            border: 'none',
            cursor: saving ? 'default' : 'pointer',
            background: 'var(--dsw-alias-accent, #5b8fd6)',
            color: '#fff',
            opacity: saving ? 0.7 : 1,
          },
        }, saving ? t('saving') : t('save')),
        notice ? h('p', { style: { margin: '12px 0 0', fontSize: '13px', color: noticeColor } }, notice.text) : null
      );
    }

    function Panel(props) {
      const t = props && props.t;
      return h('div', {
        style: {
          padding: '24px',
          maxWidth: '760px',
          fontFamily: 'inherit',
          color: 'var(--dsw-alias-text-primary, inherit)',
        },
      },
        h('h2', { style: { margin: '0 0 4px', fontSize: '22px', fontWeight: 700 } }, t('settings')),
        h('p', { style: { margin: '0 0 20px', fontSize: '13px', color: 'var(--dsw-alias-text-tertiary, inherit)' } }, t('subtitle')),
        h(ConfigForm, { t })
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'forget-me-not: dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: PANEL_ID, order: 100, label: () => t('nav'), locale: NS,
        }, () => h(Panel, { t })));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: () => t('nav'), locale: NS,
        }, (owner) => FlowerGlyph(owner && owner.size)));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
        }, () => h(Panel, { t })));
      },
    };
  },
});
