/**
 * Topbar — universal nav for the platform.
 *
 * Drop-in: <script src="/shared/topbar.js"></script>
 *
 * Discord Activity usage:
 *   import { DiscordSDK } from '@discord/embedded-app-sdk';
 *   const sdk = new DiscordSDK(CLIENT_ID);
 *   await sdk.ready();
 *   await Topbar.initDiscord(sdk);  // auto-fetches server/channel, enforces VC
 *
 * Manual session override:
 *   Topbar.setSession({ name, room, teamColor })
 *   Topbar.clearSession()
 */

(function () {
  const NAV_LEFT  = ['Training', 'Puzzles', 'Library'];
  const NAV_RIGHT = ['Contribute', 'Maps', 'Profile'];

  const NAV_HREFS = {
    Training:   '/training',
    Puzzles:    '/puzzles',
    Library:    '/library.html',
    Contribute: '/contribute',
    Maps:       '/game/maps',
    Profile:    '/profile.html',
  };

  // Paths that belong to Training even without /training prefix
  // (BT uses absolute paths internally — gateway proxies them to :8000)
  const TRAINING_PATHS = ['/games', '/cct', '/shared', '/subitizing', '/memory', '/tones'];

  const TEAM_COLORS = {
    magenta: '#e040fb',
    cyan:    '#00e5ff',
    orange:  '#ff6d00',
    green:   '#00e676',
    yellow:  '#ffea00',
    red:     '#ff1744',
    blue:    '#2979ff',
    white:   '#ffffff',
  };

  // Discord channel types that are voice
  const VOICE_TYPES = new Set([2, 13]); // GUILD_VOICE, GUILD_STAGE_VOICE
  const DM_VOICE_TYPES = new Set([1, 3]); // DM, GROUP_DM (used in VC context)

  const CSS = `
    #__topbar {
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 9999;
      background: #000;
      font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      user-select: none;
      height: 44px;
      border-bottom: 1px solid #fff;
      display: flex;
      align-items: center;
    }

    /* ── Shared slot layout: [left] [home] [right] ── */
    #__topbar-left,
    #__topbar-right {
      flex: 1;
      display: flex;
      align-items: center;
      height: 100%;
      min-width: 0;
    }

    #__topbar-left  { justify-content: flex-start; }
    #__topbar-right { justify-content: flex-end;   }

    #__topbar-home {
      flex-shrink: 0;
      font-size: 20px;
      color: #fff;
      text-decoration: none;
      padding: 0 20px;
      height: 100%;
      display: flex;
      align-items: center;
    }

    /* ── Nav links (shown in left/right slots by default) ── */
    .__tb-nav-link {
      color: #fff;
      text-decoration: none;
      font-size: 15px;
      font-weight: 400;
      text-transform: lowercase;
      letter-spacing: 0.01em;
      padding: 0 16px;
      height: 100%;
      display: flex;
      align-items: center;
      white-space: nowrap;
      opacity: 0.4;
      transition: opacity 0.15s;
    }

    .__tb-nav-link:hover,
    .__tb-nav-link.--active { opacity: 1; }

    /* ── Session slots (hidden by default) ── */
    #__topbar-session-info {
      display: none;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding-left: 16px;
    }

    #__topbar-session-info.--visible { display: flex; }

    #__topbar-session-name,
    #__topbar-session-room-label,
    #__topbar-session-extra {
      font-size: 15px;
      font-weight: 400;
      color: #fff;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      white-space: nowrap;
    }

    #__topbar-session-name {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #__topbar-session-sep,
    #__topbar-session-sep2 {
      color: #fff;
      font-size: 15px;
      flex-shrink: 0;
    }

    /* Third slot (real Discord channel name) is optional — not everyone
       testing or playing is actually inside a Discord voice channel. */
    #__topbar-session-sep2.--hidden,
    #__topbar-session-extra.--hidden {
      display: none;
    }

    #__topbar-session-dot {
      display: none; /* was an unearned white dot outside a real team color — see setTeamColor() */
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #fff;
      flex-shrink: 0;
    }

    #__topbar-refresh {
      display: none;
      background: none;
      border: none;
      color: #fff;
      font-size: 15px;
      font-weight: 400;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      padding: 0 16px;
      height: 100%;
      font-family: inherit;
      align-items: center;
    }

    #__topbar-refresh.--visible { display: flex; }

    /* ── VC enforcement overlay ── */
    #__topbar-vc-gate {
      display: none;
      position: fixed;
      inset: 0;
      background: #000;
      z-index: 99998;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 12px;
      color: #fff;
      font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    #__topbar-vc-gate.--visible { display: flex; }

    #__topbar-vc-gate-msg {
      font-size: 15px;
      font-weight: 400;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #fff;
    }

    #__topbar-vc-gate-sub {
      font-size: 12px;
      color: #444;
      letter-spacing: 0.04em;
    }

    /* Spacer */
    #__topbar-spacer { height: 44px; }
  `;

  function getActiveHref() {
    const path = window.location.pathname;
    if (path === '/' || path === '/index.html') return '/';
    for (const href of Object.values(NAV_HREFS)) {
      if (path.startsWith(href)) return href;
    }
    // BT's internal absolute paths (proxied via gateway fallback)
    if (TRAINING_PATHS.some(p => path.startsWith(p))) return '/training';
    return null;
  }

  function navLink(label) {
    const href   = NAV_HREFS[label];
    const active = href === getActiveHref() ? ' class="__tb-nav-link --active"' : ' class="__tb-nav-link"';
    return `<a${active} href="${href}">${label}</a>`;
  }

  function inject() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    document.body.insertAdjacentHTML('afterbegin', `
      <div id="__topbar-spacer"></div>
      <div id="__topbar">

        <div id="__topbar-left">
          <!-- nav mode -->
          ${NAV_LEFT.map(navLink).join('')}
          <!-- session mode -->
          <div id="__topbar-session-info">
            <span id="__topbar-session-name"></span>
            <span id="__topbar-session-sep">/</span>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
              <span id="__topbar-session-dot"></span>
              <span id="__topbar-session-room-label"></span>
            </div>
            <span id="__topbar-session-sep2">/</span>
            <span id="__topbar-session-extra"></span>
          </div>
        </div>

        <a id="__topbar-home" href="/">⌂</a>

        <div id="__topbar-right">
          <!-- nav mode -->
          ${NAV_RIGHT.map(navLink).join('')}
          <!-- session mode -->
          <button id="__topbar-refresh" onclick="window.Topbar.__doRefresh()">Refresh</button>
        </div>

      </div>

      <div id="__topbar-vc-gate">
        <span id="__topbar-vc-gate-msg">join a voice channel to use this</span>
        <span id="__topbar-vc-gate-sub">this activity requires an active voice session</span>
      </div>
    `);
  }

  // Refresh defaults to a real page reload — correct for every page that's
  // never overridden it. A caller whose "refresh" concept is narrower (e.g.
  // just reloading an embedded game iframe, not tearing down the whole
  // activity/connection) passes its own via setSession({ onRefresh }).
  let refreshHandler = () => location.reload();

  function showSession(nameText, roomText, teamColor, onRefresh, extraText) {
    // Hide nav links, show session slots
    document.querySelectorAll('.__tb-nav-link').forEach(el => el.style.display = 'none');
    document.getElementById('__topbar-session-info').classList.add('--visible');
    document.getElementById('__topbar-refresh').classList.add('--visible');

    document.getElementById('__topbar-session-name').textContent       = nameText;
    document.getElementById('__topbar-session-room-label').textContent = roomText;

    // Third slot is optional — not every caller has a real Discord channel
    // to show (testing outside Discord, a guest session), so it collapses
    // entirely rather than showing an empty label with a dangling "/".
    const sep2  = document.getElementById('__topbar-session-sep2');
    const extra = document.getElementById('__topbar-session-extra');
    extra.textContent = extraText || '';
    sep2.classList.toggle('--hidden', !extraText);
    extra.classList.toggle('--hidden', !extraText);

    const color = TEAM_COLORS[teamColor] || TEAM_COLORS[roomText] || '#fff';
    document.getElementById('__topbar-session-dot').style.background = color;

    refreshHandler = typeof onRefresh === 'function' ? onRefresh : () => location.reload();
  }

  function blockWithGate(msg, sub) {
    const gate = document.getElementById('__topbar-vc-gate');
    if (msg) document.getElementById('__topbar-vc-gate-msg').textContent = msg;
    if (sub) document.getElementById('__topbar-vc-gate-sub').textContent = sub;
    gate.classList.add('--visible');
    // Prevent page interaction behind the gate
    document.body.style.overflow = 'hidden';
  }

  const Topbar = {
    // Exposed so other pages (index.html's presence/breakout views) can
    // color-code identity against the same palette as the topbar's own
    // team dot, instead of picking their own colors.
    TEAM_COLORS,

    /**
     * Accepts an already-ready DiscordSDK instance.
     * Fetches real server/channel, enforces VC requirement.
     *
     * Channel type 2  = GUILD_VOICE       → "Server / #channel / ● team"
     * Channel type 13 = GUILD_STAGE_VOICE → same
     * guildId null    = DM/Group DM VC    → "Direct Message / ● team"
     * Not in VC       → full-screen gate
     */
    async initDiscord(sdk, opts = {}) {
      const teamColor = opts.teamColor || null;

      try {
        const channel = await sdk.commands.getChannel({ channel_id: sdk.channelId });

        const isGuildVoice = VOICE_TYPES.has(channel.type);
        const isDmVoice    = DM_VOICE_TYPES.has(channel.type);

        if (!isGuildVoice && !isDmVoice) {
          // Not in any voice context — block
          blockWithGate(
            'join a voice channel to use this',
            'this activity requires an active voice session'
          );
          return;
        }

        if (isDmVoice || !sdk.guildId) {
          // DM or Group DM voice call
          const isDm = channel.type === 1;
          this.currentChannelLabel = channel.name || 'voice';
          showSession(
            isDm ? 'direct message' : 'group call',
            channel.name || 'voice',
            teamColor
          );
          return;
        }

        // Server voice channel — fetch guild name
        let guildName = 'unknown server';
        try {
          const guild = await sdk.commands.getGuild({ guild_id: sdk.guildId, timeout: 5000 });
          guildName = guild.name;
        } catch (_) { /* guild fetch optional */ }

        // Stashed here so a later setSession() call elsewhere (entering a
        // game lobby, say) can still show the real channel as a third
        // piece without re-fetching it or duplicating the SDK call.
        this.currentChannelLabel = channel.name;
        showSession(guildName, channel.name, teamColor);

      } catch (err) {
        // channelId null or SDK error = not in a VC
        blockWithGate(
          'join a voice channel to use this',
          'this activity requires an active voice session'
        );
      }
    },

    /** Manual session (non-Discord hosting) */
    setSession(opts = {}) {
      showSession(
        opts.name || 'unnamed session',
        opts.room || 'main room',
        opts.teamColor || opts.room,
        opts.onRefresh,
        opts.extra
      );
    },

    __doRefresh() { refreshHandler(); },

    /**
     * Update just the team-color dot, leaving the server/channel name
     * text untouched — for when team assignment happens after
     * initDiscord() already showed the real voice channel info.
     */
    setTeamColor(teamColor) {
      const dot = document.getElementById('__topbar-session-dot');
      if (dot) dot.style.background = TEAM_COLORS[teamColor] || '#fff';
    },

    clearSession() {
      document.querySelectorAll('.__tb-nav-link').forEach(el => el.style.display = '');
      document.getElementById('__topbar-session-info').classList.remove('--visible');
      document.getElementById('__topbar-refresh').classList.remove('--visible');
      refreshHandler = () => location.reload(); // back to the real default for the next caller
    },

    setActive(href) {
      document.querySelectorAll('.__tb-nav-link').forEach(el => {
        el.classList.toggle('--active', el.getAttribute('href') === href);
      });
    },

    /**
     * Called by iframe content to trigger shell navigation.
     * e.g. from inside game: window.parent.Topbar.navigate('/training')
     */
    navigate(href) {
      // If running inside the shell, delegate up
      if (window.parent !== window && window.parent.Topbar) {
        window.parent.Topbar.navigate(href);
        return;
      }
      // Otherwise dispatch event for the shell to handle
      document.dispatchEvent(new CustomEvent('topbar:navigate', { detail: { href } }));
    },
  };

  const inIframe = window !== window.top;

  if (inIframe) {
    // Inside the shell's iframe — skip injection, proxy API up to parent
    window.Topbar = {
      setSession:   (...a) => window.parent.Topbar?.setSession(...a),
      clearSession: ()     => window.parent.Topbar?.clearSession(),
      navigate:     (href) => window.parent.Topbar?.navigate(href),
      setActive:    (href) => window.parent.Topbar?.setActive(href),
      initDiscord:  (...a) => window.parent.Topbar?.initDiscord(...a),
      setTeamColor: (...a) => window.parent.Topbar?.setTeamColor(...a),
    };
  } else {
    window.Topbar = Topbar;
    if (document.body) {
      inject();
    } else {
      // Loaded from <head>: inject the instant the parser creates <body>.
      // DOMContentLoaded waits on every script and module on the page, which
      // is what made the bar pop in a beat after everything else.
      const observer = new MutationObserver(() => {
        if (!document.body) return;
        observer.disconnect();
        inject();
      });
      observer.observe(document.documentElement, { childList: true });
    }
  }
})();
