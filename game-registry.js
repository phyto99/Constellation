// game-registry.js
// Single source of truth for every game type in the admin panel.
//
// ── Field types ──────────────────────────────────────────────────────────────
//   number      <input type="number"> with min/max/default
//   text        <input type="text">
//   url         <input type="url">
//   checkbox    single checkbox
//   select      <select> with options: [{value, label}]
//   map         map-file dropdown + JSON textarea (Constellation only)
//   multipliers 4-input score multiplier row with randomise button
//   ai-bots     bot adder with type/team/aggression selects
//
// ── Registry entry keys ──────────────────────────────────────────────────────
//   label        Display name shown in dropdown
//   description  Subtitle shown in room list
//   roomType     Colyseus room name passed to client.create() and matchMaker.query()
//   joinPath     (roomId, cfg, runtime) => URL string
//                  cfg     = readSettings() output for this game
//                  runtime = per-room transient state { sessionCode, ... }
//   teamSupport  true → team manager panel is relevant for this game
//   maxPlayers   default max clients for room creation
//   fields       array of field descriptors (drives settings panel HTML + readers)
//   botContext   null, or { types[] } — presence means this game supports bots.
//                Extend with moveGenerator/stateEvaluator/applyMove when implementing
//                server-side bot logic (see GAME_INTEGRATION.md).
//
// ── Adding a new game ────────────────────────────────────────────────────────
//   See GAME_INTEGRATION.md for the complete checklist.
//   Short version:
//     1. Add entry here (copy the C4D block as a template)
//     2. Add ADMIN_SETTINGS_ADAPTERS entry in admin.html
//     3. Create server Room class extending BaseGameRoom in server.js
//     4. Add entry to SERVER_GAME_TYPES in server.js
//     5. Add static route(s) in server.js if the game has its own client

const GAME_REGISTRY = {

  Constellation: {
    label: 'Constellation',
    description: 'Star-claiming multiplayer strategy game',
    roomType: 'constellation',
    joinPath: (roomId) => `${location.protocol}//${location.host}/game/${roomId}`,
    teamSupport: true,
    maxPlayers: 20,
    fields: [
      { key: 'map',    type: 'map' },
      { key: 'moves',          type: 'number', label: 'Moves',            sublabel: 'Moves per round',         default: 15,  min: 1,  max: 99  },
      { key: 'rounds',         type: 'number', label: 'Rounds',           sublabel: 'Number of rounds',         default: 10,  min: 1,  max: 99  },
      { key: 'roundLength',    type: 'number', label: 'Round Length',     sublabel: 'Seconds per round',        default: 30,  min: 10, max: 300 },
      { key: 'countdownLength',type: 'number', label: 'Countdown Length', sublabel: 'Seconds before game starts',default: 5,  min: 0,  max: 60  },
      { key: 'steals',         type: 'number', label: 'Steals',           sublabel: 'Steals allowed',           default: 15,  min: 0,  max: 99  },
      { key: 'headquarters',   type: 'number', label: 'Headquarters',     sublabel: 'Number of HQs',            default: 2,   min: 0,  max: 20  },
      { key: 'multipliers',    type: 'multipliers' },
      { key: 'allowPlayerTeamSelection', type: 'checkbox', label: 'Allow Player Team Selection',
        sublabel: 'Players can pick their team from the game client', default: false },
      { key: 'aiBots', type: 'ai-bots' },
    ],
    // Bot context: describes capabilities available to server-side BotPlayer instances.
    // Only Constellation currently has implemented bot logic (ConstellationRoom handles
    // the aiBots option natively). Future games can add botContext and implement a
    // BotPlayer class that uses moveGenerator/stateEvaluator/applyMove.
    botContext: {
      types: ['random', 'greedy', 'minimax'],
      // moveGenerator(gs, teamIdx) => move[]   — return legal moves from current state
      // stateEvaluator(gs, teamIdx) => number  — higher = better for teamIdx
      // applyMove(gs, move) => gs              — pure state transition (no mutation)
      // isTerminal(gs) => boolean              — true when game is over
      // moveToMessage(move) => {type, data}    — Colyseus message to send the move
    },
  },

  'Tabletop Club': {
    label: 'Tabletop Club',
    description: 'External board game session via Tabletop Club (drwhut)',
    roomType: 'constellation',
    joinPath: (roomId, cfg = {}) => (cfg.tableUrl && cfg.tableUrl !== '#') ? cfg.tableUrl : '#',
    teamSupport: false,
    maxPlayers: 8,
    fields: [
      { key: 'tableUrl',     type: 'url',    label: 'Game URL',       sublabel: 'Tabletop Club server URL to share with players', default: 'http://localhost:2567/ttclub/seepcards.html' },
      { key: 'maxPlayers',   type: 'number', label: 'Max Players',    default: 4, min: 2, max: 8 },
      { key: 'tableFile',    type: 'text',   label: 'Table File',     sublabel: '.tc table file name (optional)', default: '' },
      { key: 'roomPassword', type: 'text',   label: 'Room Password',  sublabel: 'Optional room password', default: '' },
    ],
    botContext: null,
  },

  Geobridge: {
    label: 'Geobridge (beta)',
    description: 'Geography bridge card game (3 players)',
    roomType: 'geobridge',
    // sessionCode lives in runtime — generated once per admin session, persisted in roomRuntimeState
    joinPath: (roomId, cfg = {}, runtime = {}) => {
      const p = new URLSearchParams({
        sessionCode:          runtime.sessionCode || 'XXXXXX',
        timerDuration:        cfg.timerDuration        || 10,
        biddingTimerDuration: cfg.biddingTimerDuration || 20,
        playTimerDuration:    cfg.playTimerDuration    || 20,
        cardsToPlay:          cfg.cardsToPlay          || 8,
        extraCards:           cfg.extraCards           || 2,
        numRounds:            cfg.numRounds            || 3,
        eclipseEnabled:       cfg.eclipseEnabled !== false,
        alliancePenalty:      cfg.alliancePenaltyAmount || 5,
        bidPenalty:           cfg.bidPenaltyAmount      || 20,
      });
      if (Array.isArray(cfg.teamColors)) {
        cfg.teamColors.slice(0, 3).forEach((tc, i) => {
          const hex = typeof tc.color === 'number'
            ? tc.color.toString(16).padStart(6, '0')
            : '';
          if (hex) p.set(`tc${i + 1}`, hex);
        });
      }
      return `${location.protocol}//${location.host}/geobridge?${p}`;
    },
    teamSupport: true,
    maxPlayers: 3,
    fields: [
      { key: 'timerDuration',        type: 'number', label: 'Timer Duration',         sublabel: 'Seconds', default: 10, min: 5,  max: 120, step: 5  },
      { key: 'biddingTimerDuration', type: 'number', label: 'Bidding Timer',           sublabel: 'Seconds', default: 20, min: 5,  max: 120, step: 5  },
      { key: 'playTimerDuration',    type: 'number', label: 'Play Timer',              sublabel: 'Seconds', default: 20, min: 5,  max: 120, step: 5  },
      { key: 'cardsToPlay',          type: 'number', label: 'Cards to Play',           default: 8,  min: 1, max: 20  },
      { key: 'extraCards',           type: 'number', label: 'Extra Cards',             default: 2,  min: 0, max: 10  },
      { key: 'numRounds',            type: 'number', label: 'Rounds',                  default: 3,  min: 1, max: 10  },
      { key: 'alliancePenaltyAmount',type: 'number', label: 'Alliance Penalty',        default: 5,  min: 0, max: 50  },
      { key: 'bidPenaltyAmount',     type: 'number', label: 'Bid Penalty',             default: 20, min: 0, max: 100, step: 5 },
      { key: 'eclipseEnabled',       type: 'checkbox', label: 'Eclipse Enabled',       default: true },
    ],
    botContext: null,
  },

  GOLAD: {
    label: 'GOLAD',
    description: 'Game of Life and Death — turn-based cellular automaton (2 players)',
    roomType: 'golad',
    joinPath: (roomId) => `${location.protocol}//${location.host}/golad/${roomId}`,
    teamSupport: false,
    maxPlayers: 2,
    fields: [
      { key: 'boardSize',   type: 'number', label: 'Board Size', sublabel: 'Grid width/height (N×N)', default: 16, min: 8, max: 30 },
      // Additional GOLAD fields (p1Type, p2Type, colors, cellShape, birth, survive, hints, animations)
      // are rendered by the custom #golad-settings panel — the admin settings adapter handles them.
    ],
    botContext: null,
  },

  Centauri: {
    label: 'Centauri',
    description: 'Zero-gravity spaceship physics multiplayer',
    roomType: 'centauri',
    joinPath: (roomId) => `${location.protocol}//${location.host}/centauri/${roomId}`,
    teamSupport: true,
    maxPlayers: 20,
    fields: [
      // Centauri fields are rendered by the custom #centauri-settings panel.
      // The admin settings adapter reads them.
    ],
    botContext: null,
  },

  C4D: {
    label: 'C4D (beta)',
    description: '4D polytope territory game — claim vertices on cross-sections of 4D shapes',
    roomType: 'c4d',
    joinPath: (roomId) => `${location.protocol}//${location.host}/c4d/${roomId}`,
    teamSupport: true,
    maxPlayers: 20,
    fields: [
      { key: 'teamCount',     type: 'number', label: 'Teams',          sublabel: '2–6 competing teams',              default: 2, min: 2, max: 6 },
      { key: 'wMode',         type: 'select', label: 'W-Plane Mode',   sublabel: 'How the 4D slice advances each round',
        default: 'oscillate', options: [
          { value: 'oscillate',     label: 'Oscillate — bounces back and forth' },
          { value: 'sequential',    label: 'Sequential — starts center, advances right (teams must be coprime with plane count)' },
          { value: 'random',        label: 'Random — seeded shuffle' },
          { value: 'player-choice', label: 'Player Choice — active player picks' },
          { value: 'vote',          label: 'Vote — all players vote secretly' },
        ]},
      { key: 'ownerMode',     type: 'select', label: 'Ownership',      sublabel: 'Claiming rules',
        default: 'permanent', options: [
          { value: 'permanent',   label: 'Permanent — first claim is final' },
          { value: 'contestable', label: 'Contestable — enemy can reclaim' },
        ]},
      { key: 'scoring',       type: 'select', label: 'Scoring Preset',
        default: 'exponential', options: [
          { value: 'exponential', label: 'Exponential — V·1 + E·3 + F·9 + C·27' },
          { value: 'flat',        label: 'Flat — V·1 + E·1 + F·1 + C·1' },
          { value: 'cells',       label: 'Cells Only — C·1' },
        ]},
      { key: 'victory',       type: 'select', label: 'Victory Condition',
        default: 'last-plane', options: [
          { value: 'last-plane', label: 'Last Plane — most score after all planes' },
          { value: 'first-cell', label: 'First Cell — first complete 3D cell wins' },
        ]},
      { key: 'claimsPerTurn', type: 'number', label: 'Claims per Turn', sublabel: 'Edges/vertices claimable per turn', default: 1, min: 1, max: 3 },
      { key: 'fogOfWar',      type: 'checkbox', label: 'Fog of War',    sublabel: 'Hide reference structure except completed cells', default: false },
    ],
    botContext: null,
  },

  'No game focus': {
    label: 'No game focus',
    description: 'Freeform session without a specific game',
    roomType: 'constellation',
    joinPath: (roomId) => `${location.protocol}//${location.host}/game/${roomId}`,
    teamSupport: true,
    maxPlayers: 20,
    fields: [],
    botContext: null,
  },

};

// Returns the schema for a given game type, falling back to Constellation.
function getGameSchema(gameType) {
  return GAME_REGISTRY[gameType] || GAME_REGISTRY['Constellation'];
}
