// game-registry.js
// Defines available game types for the admin panel.
// Each entry specifies the settings fields shown in the Game Settings panel
// when a room of that type is selected.
//
// Field types:
//   number   – <input type="number"> with min/max
//   text     – <input type="text">
//   url      – <input type="url"> (same as text but validated by browser)
//   checkbox – single checkbox with label
//   select   – <select> dropdown, requires `options` array of {value, label}
//   map      – special: map-file dropdown + JSON textarea (Constellation only)
//   multipliers – special: 4-input score multiplier row with randomise button
//   ai-bots  – special: bot adder with type/team/aggression selects
//
// All simple field keys are used both as:
//   - the property name sent to the server via update_settings
//   - the DOM element id prefix: id="edit-{key}"
//
// Server-side field name reference (ConstellationRoom gameConfig):
//   moves, rounds, roundLength, countdownLength, steals, headquarters,
//   multipliers, aiBots, teamColors, allowPlayerTeamSelection, customMapFilename

const GAME_REGISTRY = {

  Constellation: {
    label: 'Constellation',
    description: 'Star-claiming multiplayer strategy game',
    roomType: 'constellation',
    // The join URL for players (relative, roomId filled in at runtime)
    joinPath: (roomId) => `/game/${roomId}`,
    fields: [
      {
        key: 'map', type: 'map'
        // rendered as map-file dropdown + textarea; no label/default needed
      },
      {
        key: 'moves', type: 'number',
        label: 'Moves', sublabel: 'Number of moves per round',
        default: 15, min: 1, max: 99
      },
      {
        key: 'rounds', type: 'number',
        label: 'Rounds', sublabel: 'Number of rounds',
        default: 10, min: 1, max: 99
      },
      {
        key: 'roundLength', type: 'number',
        label: 'Round Length', sublabel: 'Seconds per round',
        default: 30, min: 10, max: 300
      },
      {
        key: 'countdownLength', type: 'number',
        label: 'Countdown Length', sublabel: 'Seconds before game starts',
        default: 5, min: 0, max: 60
      },
      {
        key: 'steals', type: 'number',
        label: 'Steals', sublabel: 'Number of steals allowed',
        default: 15, min: 0, max: 99
      },
      {
        key: 'headquarters', type: 'number',
        label: 'Headquarters', sublabel: 'Number of Headquarters',
        default: 2, min: 0, max: 20
      },
      {
        key: 'multipliers', type: 'multipliers'
        // rendered as 4 inputs + randomise button
      },
      {
        key: 'allowPlayerTeamSelection', type: 'checkbox',
        label: 'Allow Player Team Selection',
        sublabel: 'Players can pick their team from the game client',
        default: false
      },
      {
        key: 'aiBots', type: 'ai-bots'
        // rendered as bot adder
      },
    ]
  },

  'Tabletop Club': {
    label: 'Tabletop Club',
    description: 'External board game session via Tabletop Club (drwhut)',
    roomType: 'constellation',
    // Join URL taken from the tableUrl field the admin enters
    joinPath: (roomId, cfg) => (cfg && cfg.tableUrl) ? cfg.tableUrl : '#',
    fields: [
      {
        key: 'tableUrl', type: 'url',
        label: 'Game URL',
        sublabel: 'Tabletop Club server or room URL to share with players',
        default: 'http://localhost:2567/ttclub/seepcards.html',
        onchange: 'sendSettingsUpdate(); updateTTClubPanel();'
      },
      {
        key: 'maxPlayers', type: 'number',
        label: 'Max Players',
        default: 4, min: 2, max: 8
      },
      {
        key: 'tableFile', type: 'text',
        label: 'Table File', sublabel: '.tc table file name to pre-load (optional)',
        default: ''
      },
      {
        key: 'roomPassword', type: 'text',
        label: 'Room Password', sublabel: 'Optional room password',
        default: ''
      },
    ]
  },

  Geobridge: {
    label: 'Geobridge',
    description: 'Geography bridge game',
    roomType: 'constellation',
    joinPath: (roomId) => `/game/${roomId}`,
    fields: [
      {
        key: 'rounds', type: 'number',
        label: 'Rounds', sublabel: 'Number of rounds',
        default: 5, min: 1, max: 20
      },
      {
        key: 'roundLength', type: 'number',
        label: 'Round Length', sublabel: 'Seconds per round',
        default: 60, min: 10, max: 300
      },
      {
        key: 'allowPlayerTeamSelection', type: 'checkbox',
        label: 'Allow Player Team Selection',
        sublabel: 'Players can pick their team from the game client',
        default: true
      },
    ]
  },

  GOLAD: {
    label: 'GOLAD',
    description: 'Game of Life and Death — turn-based cellular automaton (2 players)',
    roomType: 'golad',
    joinPath: (roomId) => `/golad/${roomId}`,
    fields: [
      {
        key: 'boardSize', type: 'number',
        label: 'Board Size', sublabel: 'Grid width/height (N×N)',
        default: 16, min: 8, max: 30
      },
    ]
  },

  'No game focus': {
    label: 'No game focus',
    description: 'Freeform session without a specific game',
    roomType: 'constellation',
    joinPath: (roomId) => `/game/${roomId}`,
    fields: []
  }
};

// Convenience: returns the schema for a given type, falling back to Constellation.
function getGameSchema(gameType) {
  return GAME_REGISTRY[gameType] || GAME_REGISTRY['Constellation'];
}
