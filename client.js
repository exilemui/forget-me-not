window.__ModuleLoader__.load({
  id: '@local/forget-me-not',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'forget-me-not';
    const PANEL_ID = 'forget-me-not';

    const zh = {
      nav: '勿忘我',
      title: '勿忘我 · forget-me-not',
      desc: '人类遗忘式记忆插件。它把每一次会话按时间顺序提取成「印象」，随遗忘时钟逐轮淡忘（8 轮：100% → 85% → 80% → 70% → 60%×4 → 彻底遗忘），用本地向量召回唤起旧记忆（仅供参考、不迷信），并可把刻骨铭心的东西写进「笔记本」。',
      configHint: '存储目录、遗忘比例、embedding 模型、召回阈值、语言等配置，请在「插件管理」页编辑 forget-me-not 的配置项。',
      greeting: '我是「念」（Nian），勿忘我里的智能体。',
    };
    const en = {
      nav: 'forget-me-not',
      title: 'forget-me-not',
      desc: 'A human-forgetting memory plugin: each session is distilled into an impression and faded on a clock (8 rounds: 100% → 85% → 80% → 70% → 60%×4 → forgotten), recalled by local vector search (reference, not dogma), with a notebook for what you never want to lose.',
      configHint: 'Edit storeDir, decay ratios, embedding model, recall thresholds and language on the plugin manager page.',
      greeting: 'My name is "Nian" — the agent inside forget-me-not.',
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
        h('h2', { style: { margin: '0 0 12px', fontSize: '20px', fontWeight: 600 } }, t('title')),
        h('p', { style: { margin: '0 0 14px', fontSize: '14px', lineHeight: 1.8, color: 'var(--dsw-alias-text-secondary, inherit)' } }, t('desc')),
        h('p', { style: { margin: '0 0 14px', fontSize: '13px', lineHeight: 1.7, color: 'var(--dsw-alias-text-tertiary, inherit)' } }, t('configHint')),
        h('p', { style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-text-secondary, inherit)' } }, t('greeting'))
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
