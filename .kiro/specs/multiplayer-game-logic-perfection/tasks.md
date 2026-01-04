# Implementation Plan: Multiplayer Game Logic Perfection

## Overview

This implementation plan focuses on perfecting the transition from single-player to multiplayer game logic, with emphasis on:
1. **AI Bot server-side integration** - Making bots function identically to human players
2. **Dynamic team color synchronization** - Modular colors from admin panel/color.html to all clients
3. **Bulletproof validation logic** - Ensuring all game rules are enforced consistently
4. **Special star parsing fixes** - Black hole and wormhole min/max requirements

## Tasks

- [ ] 1. Server-Side Bot Integration (Critical)
  - [ ] 1.1 Add bot player registration on server when game starts
    - Modify `server.js` ConstellationRoom to create Player entries for each configured bot
    - Bots must be added to `this.state.players` MapSchema with unique IDs (e.g., `bot_0`, `bot_1`)
    - Set `player.team` to the bot's configured `teamIndex`
    - Bots must be included in `distributeMoves()` calculation
    - _Requirements: 7.1, 7.6, 7.7, 8.6, 17.6, 17.7_

  - [ ] 1.2 Fix AIBot to use individual player moves instead of team moves
    - In `index.html` AIBot class, change `game.tms[this.teamIndex].movesLeft` check to use bot's individual move allocation
    - Add `this.playerId` property to AIBot to track server-assigned ID
    - Add `this.movesLeft` property synced from server state
    - Modify `executeMove()` to check `this.movesLeft` instead of team total
    - _Requirements: 8.2, 9.1, 9.5_

  - [ ] 1.3 Sync bot moves from server broadcasts
    - In `index.html`, when receiving `round_started` with `playerMoves`, update each bot's `movesLeft`
    - When receiving `state_changed`, update bot's local move count
    - Ensure bots see the same move allocation as server tracks
    - _Requirements: 9.4, 10.1, 10.2_

- [ ] 2. Team Color Synchronization System
  - [ ] 2.1 Add teamColors to server gameConfig
    - In `server.js`, add default `teamColors` array to `this.gameConfig` in `onCreate()`
    - Structure: `[{ color: 0x00FFFF, name: 'cyan', displayName: 'Cyan' }, ...]`
    - Include teamColors in `settings_update` broadcasts
    - Include teamColors in `game_started` message
    - _Requirements: 19.1, 19.2, 19.3_

  - [ ] 2.2 Add updateTeamColors method to Game class
    - In `index.html`, add `updateTeamColors(teamColors)` method to Game class
    - Update `this.tms` array with new color values
    - Map server format `{ color, name, displayName }` to client format `{ c, name, displayName }`
    - Trigger full UI refresh after update
    - _Requirements: 19.4, 19.5, 20.5_

  - [ ] 2.3 Modify handleSettingsUpdate to process team colors
    - In `index.html`, update `handleSettingsUpdate(data)` to check for `data.config.teamColors`
    - Call `this.updateTeamColors(data.config.teamColors)` when present
    - Ensure leaderboard, header, and star rendering use updated colors
    - _Requirements: 19.4, 21.4, 22.4_

  - [ ] 2.4 Update admin.html to send teamColors in settings
    - In `admin.html`, modify `sendSettingsUpdate()` to include current team colors
    - Integrate with color.html optimizer output when available
    - Send teamColors array in `update_settings` message
    - _Requirements: 19.1, 22.2, 22.3_

- [ ] 3. Checkpoint - Verify bot and color sync
  - Ensure bots receive individual move allocations from server
  - Ensure team colors update across all clients when admin changes them
  - Ask user if questions arise

- [ ] 4. Validation Logic Perfection
  - [ ] 4.1 Clean up redundant validation code in server.js
    - Remove commented-out `team.movesLeft` check in `validateClaim()`
    - Add clear comments explaining validation flow (handler checks player.movesLeft, validation checks game rules)
    - Ensure validation functions are pure (no side effects)
    - _Requirements: 1.1, 1.4, 8.1, 8.7_

  - [ ] 4.2 Add player context to validation for bot parity
    - Modify `claim_star`, `steal_star`, `place_hq` handlers to pass player object to validation
    - Ensure bot moves go through exact same validation path as human moves
    - Add `playerId` to validation context for logging/debugging
    - _Requirements: 8.1, 8.7, 8.8_

  - [ ] 4.3 Implement move rejection rollback for optimistic updates
    - In `index.html`, enhance `move_rejected` handler to properly rollback bot optimistic updates
    - Track pending moves with their original state for rollback
    - Ensure bot doesn't retry rejected move types until state changes
    - _Requirements: 1.3, 9.6, 10.3_

- [ ] 5. Special Star Parsing Fixes
  - [ ] 5.1 Fix black hole min/max requirement parsing
    - In `index.html` map loading, ensure black holes parse `[x, y, 3, minReq, maxReq]` format
    - Store `minReq` and `maxReq` on star object during planning phase
    - Display requirement range in UI during planning
    - _Requirements: 13.1, 13.2, 18.2, 18.4_

  - [ ] 5.2 Fix wormhole min/max requirement parsing
    - In `index.html` map loading, ensure wormholes parse `[x, y, 4, minReq, maxReq]` format
    - Store `minReq` and `maxReq` on star object during planning phase
    - Display requirement range in UI during planning
    - _Requirements: 14.1, 14.2, 18.3, 18.4_

  - [ ] 5.3 Server-side random requirement generation
    - In `server.js`, when game starts, generate random `req` value between `minReq` and `maxReq` for each special star
    - Broadcast actual requirements to all clients in `game_started` message
    - Ensure all clients use server-generated requirements (not local random)
    - _Requirements: 13.3, 14.3, 18.6_

- [ ] 6. Checkpoint - Verify validation and special stars
  - Test that bot moves are rejected with same errors as human moves
  - Test that black holes and wormholes display correct requirement ranges
  - Test that server-generated requirements are consistent across all clients
  - Ask user if questions arise

- [ ] 7. Player Session Leave with Move Transfer
  - [ ] 7.1 Add beforeunload dialog for move transfer choice
    - In `index.html`, add `beforeunload` event listener
    - Show confirm dialog: "Leaving the session? Transfer moves to teammates or don't"
    - Send leave message to server with transfer choice
    - _Requirements: 3.1, 3.8_

  - [ ] 7.2 Implement server-side move redistribution on leave
    - In `server.js` `onLeave()`, check if player chose to transfer moves
    - If transfer: redistribute `player.movesLeft` to remaining teammates
    - If no transfer: just remove player, don't redistribute
    - Recalculate team size for future move distributions
    - _Requirements: 3.2, 3.3, 3.4, 3.7_

- [ ] 8. HQ and Steal Limit Enforcement Verification
  - [ ] 8.1 Verify HQ limit enforcement
    - Test that `validateHQ()` correctly rejects when `team.hqCount >= gameConfig.headquarters`
    - Ensure HQ count is tracked per team, not per player
    - Verify first moves are automatically treated as HQ placements
    - _Requirements: 4.1, 4.3, 4.4, 12.1, 12.4_

  - [ ] 8.2 Verify steal limit enforcement
    - Test that `validateSteal()` correctly rejects when `team.stealsLeft <= 0`
    - Ensure steals are tracked per team, shared among all members
    - Verify unstealable star types (cluster, blackhole, HQ, protected) are rejected
    - _Requirements: 5.2, 5.3, 5.6, 6.1, 6.2, 6.3, 6.4_

- [ ] 9. Final Checkpoint - Full Integration Test
  - Test complete game flow with human players and AI bots
  - Verify team colors sync from admin panel to all clients
  - Verify bots follow exact same rules as humans
  - Verify special star mechanics work correctly
  - Ensure all tests pass, ask user if questions arise

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Priority order: Bot integration → Color sync → Validation → Special stars → Leave handling
- All changes should be incremental improvements to existing working code
