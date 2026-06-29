# Requirements Document

## Introduction

This specification addresses critical game logic issues in the Star Conquest multiplayer implementation to ensure perfect parity with the original single-player version. The goal is to create a bulletproof, server-authoritative game system where all rules are enforced consistently for both human players and AI bots, making illegal moves impossible and ensuring all game mechanics work identically to the original implementation.

**Key Principle**: Polish the existing working Colyseus implementation rather than rewriting it. All changes should be incremental improvements to the current system.

## Glossary

- **Star**: A node on the game map that can be claimed by teams
- **Team**: A group of players (human or AI) competing together, identified by color
- **HQ (Headquarters)**: A special star designation that provides bonuses; limited per team
- **Steal**: Taking a star from another team; consumes a steal resource
- **Move**: An action that claims or steals a star; distributed among team members per round
- **Bot/AI_Bot**: Computer-controlled player that follows strategy patterns; treated identically to human players
- **Cluster_Star**: Special star type (T.C = 2) that cannot be stolen
- **Black_Hole**: Special star type (T.B = 3) with min/max requirement; explodes connections when requirement met
- **Wormhole**: Special star type (T.W = 4) with min/max requirement; ends game when requirement met
- **Server**: The Colyseus game server that validates all moves
- **Client**: The browser-based game interface
- **Connection**: A line between two stars owned by the same team (overlaps allowed for black holes, no overlaps for wormholes)

## Requirements

### Requirement 1: Server-Authoritative Move Validation

**User Story:** As a game administrator, I want all moves to be validated by the server, so that no illegal moves can ever occur regardless of client-side bugs or manipulation.

#### Acceptance Criteria

1. WHEN any player (human or bot) attempts to claim a star, THE Server SHALL validate the move before applying it
2. WHEN a move fails validation, THE Server SHALL reject it and send a rejection message with the reason
3. WHEN a move is rejected, THE Client SHALL revert any optimistic updates and display the rejection reason
4. THE Server SHALL maintain the single source of truth for all game state
5. WHEN the client state diverges from server state, THE Client SHALL resync to server state

### Requirement 2: Move Distribution Among Team Members

**User Story:** As a player on a team, I want moves to be fairly distributed among team members, so that each player gets their share of actions.

#### Acceptance Criteria

1. WHEN a round starts, THE Server SHALL calculate each player's movesLeft as: floor(teamMoves / teamSize) + (1 if playerIndex < teamMoves % teamSize else 0)
2. WHEN a player makes a valid move, THE Server SHALL decrement that player's movesLeft by exactly 1
3. WHEN a player has movesLeft equal to 0, THE Server SHALL reject all move attempts from that player
4. THE sum of all team members' movesLeft SHALL equal exactly the team's configured moves-per-round
5. WHEN a new round begins, THE Server SHALL recalculate and reset all player movesLeft values
6. EXAMPLE: A 3-player team with 10 moves: Player 0 gets 4, Player 1 gets 3, Player 2 gets 3

### Requirement 3: Player Session Leave with Move Transfer Option

**User Story:** As a player, I want to choose whether to transfer my remaining moves to teammates when leaving, so that I can decide if my team benefits from my departure.

#### Acceptance Criteria

1. WHEN a player attempts to close the browser/leave session, THE Client SHALL show a JavaScript confirm dialog: "Leaving the session? Transfer moves to teammates or don't"
2. IF the player chooses "Transfer moves", THEN THE Server SHALL redistribute the leaving player's remaining moves to other team members
3. IF the player chooses "Don't transfer", THEN THE Server SHALL NOT redistribute moves; remaining team members keep only their original allocation
4. WHEN a player leaves (either option), THE Server SHALL decrement that team's active player count (teamSize)
5. WHEN teamSize decreases without transfer, THE team's effective moves become: (originalMoves / originalTeamSize) * newTeamSize
6. EXAMPLE: 3-player team, 10 moves each round. One leaves without transfer: remaining 2 players have 6.67 (rounded) total moves
7. WHEN a player leaves with transfer, THE Server SHALL immediately redistribute their movesLeft to remaining teammates
8. THE leave dialog SHALL appear on beforeunload event

### Requirement 4: HQ Limit Enforcement

**User Story:** As a player, I want HQ limits to be strictly enforced, so that no team can have more headquarters than the configured maximum.

#### Acceptance Criteria

1. WHEN a team's hqCount equals the configured headquarters limit, THE Server SHALL reject all HQ placement attempts for that team
2. WHEN an HQ is successfully placed, THE Server SHALL increment the team's hqCount by exactly 1
3. THE Server SHALL track hqCount per team, not per player
4. WHEN validating HQ placement, THE Server SHALL check team.hqCount < gameConfig.headquarters
5. IF a team attempts to place an HQ when at limit, THEN THE Server SHALL return rejection with reason "HQ limit reached"
6. WHEN a game starts, THE Server SHALL initialize all team hqCount values to 0

### Requirement 5: Steal Limits Enforcement

**User Story:** As a player, I want steal limits to be strictly enforced, so that no team can steal more stars than allowed.

#### Acceptance Criteria

1. WHEN a game starts, THE Server SHALL set each team's stealsLeft to the configured steals value
2. WHEN a steal is successful, THE Server SHALL decrement the team's stealsLeft by exactly 1
3. WHEN a team's stealsLeft equals 0, THE Server SHALL reject all steal attempts for that team
4. IF a steal attempt is made with stealsLeft equal to 0, THEN THE Server SHALL return rejection with reason "No steals remaining"
5. THE Server SHALL track stealsLeft per team, shared among all team members
6. WHEN validating a steal, THE Server SHALL verify team.stealsLeft > 0 before allowing

### Requirement 6: Unstealable Star Types

**User Story:** As a player, I want certain star types to be protected from stealing, so that game mechanics work correctly.

#### Acceptance Criteria

1. WHEN a player attempts to steal a Cluster_Star (type 2), THE Server SHALL reject with reason "Cannot steal cluster star"
2. WHEN a player attempts to steal a Black_Hole (type 3), THE Server SHALL reject with reason "Cannot steal black hole"
3. WHEN a player attempts to steal an HQ star, THE Server SHALL reject with reason "Cannot steal HQ"
4. WHEN a player attempts to steal a protected star (pr=true), THE Server SHALL reject with reason "Star is protected"
5. WHEN a player attempts to steal their own team's star, THE Server SHALL reject with reason "Cannot steal own star"
6. WHEN a player attempts to steal an unclaimed star, THE Server SHALL reject with reason "Cannot steal unclaimed star"

### Requirement 7: AI Bot Team Assignment and Color

**User Story:** As a game administrator, I want AI bots to be properly assigned to teams with correct colors, so that bots are visually distinguishable and play for the correct team.

#### Acceptance Criteria

1. WHEN an AI bot is created, THE System SHALL assign it to the specified teamIndex
2. WHEN an AI bot is assigned to a team, THE Bot SHALL use that team's color for all visual representations
3. WHEN an AI bot makes moves, THE moves SHALL be attributed to the bot's assigned team
4. THE AI bot's teamIndex SHALL remain constant throughout the game
5. WHEN displaying bot information, THE UI SHALL show the correct team color indicator
6. WHEN multiple bots are on the same team, THE System SHALL share team resources (moves, steals, HQs) among them
7. THE Bot SHALL be initialized with the exact same properties as a human player on that team

### Requirement 8: AI Bot Move Validation (Identical to Human)

**User Story:** As a player, I want AI bots to follow the exact same rules as human players with absolutely no preferential treatment, so that the game is fair.

#### Acceptance Criteria

1. WHEN an AI bot attempts a move, THE Server SHALL validate it using the EXACT same validation functions as human moves
2. WHEN an AI bot's allocated moves are exhausted, THE Bot SHALL not be able to make any moves
3. WHEN an AI bot's team has no steals remaining, THE Bot SHALL not be able to steal
4. WHEN an AI bot's team has reached HQ limit, THE Bot SHALL not be able to place HQs
5. WHEN an AI bot targets an unstealable star, THE move SHALL be rejected by the server identically to a human attempt
6. THE AI bot SHALL receive moves from the same distribution algorithm as human players
7. THE Server SHALL NOT have any special code paths that treat bot moves differently from human moves
8. IF a bot attempts an illegal move, THE Server SHALL reject it with the same error as a human would receive

### Requirement 9: AI Bot Resource Tracking

**User Story:** As a game administrator, I want AI bots to correctly track and respect team resources, so that bots cannot exceed limits.

#### Acceptance Criteria

1. WHEN an AI bot analyzes game state, THE Bot SHALL read the current player.movesLeft value (not team total)
2. WHEN an AI bot analyzes game state, THE Bot SHALL read the current team.stealsLeft value
3. WHEN an AI bot analyzes game state, THE Bot SHALL read the current team.hqCount value
4. WHEN team resources change (from any source), THE Bot SHALL see the updated values on next analysis
5. THE Bot SHALL not maintain separate resource counters that could diverge from server state
6. WHEN a bot's move is rejected, THE Bot SHALL not retry the same invalid move type until state changes

### Requirement 10: Multiplayer State Synchronization

**User Story:** As a player, I want all clients to see the same game state, so that the game is consistent across all players.

#### Acceptance Criteria

1. WHEN the server broadcasts a state change, ALL connected clients SHALL apply the same update
2. WHEN a client receives a state_changed message, THE Client SHALL update local state to match
3. WHEN a client receives a move_rejected message, THE Client SHALL revert optimistic updates
4. WHEN a new player joins mid-game, THE Server SHALL send the complete current game state
5. WHEN a player reconnects, THE Client SHALL resync to current server state
6. THE Server SHALL broadcast delta updates for efficiency, not full state

### Requirement 11: Round Transition Logic

**User Story:** As a player, I want round transitions to work correctly, so that resources are properly reset and the game progresses smoothly.

#### Acceptance Criteria

1. WHEN a round ends, THE Server SHALL increment the round counter by exactly 1
2. WHEN a new round starts, THE Server SHALL recalculate and distribute movesLeft to all players based on current teamSize
3. WHEN a new round starts, THE Server SHALL NOT reset stealsLeft (steals are per-game, not per-round)
4. WHEN a new round starts, THE Server SHALL NOT reset hqCount (HQs persist)
5. WHEN the final round ends, THE Server SHALL broadcast game_ended with final scores
6. WHEN a round starts, THE Server SHALL broadcast round_started with updated player moves

### Requirement 12: First Moves Must Be HQ Placements

**User Story:** As a player, I want the game to enforce that teams place their HQs before making other moves, so that the game follows proper strategy rules.

#### Acceptance Criteria

1. WHEN a team has hqCount less than the configured headquarters limit, THE first moves SHALL automatically be HQ placements
2. WHEN a player claims a star and team.hqCount < headquarters limit, THE Server SHALL treat it as an HQ placement
3. WHEN all HQs are placed (team.hqCount >= headquarters), THE subsequent moves SHALL be regular claims
4. THE Server SHALL determine HQ vs regular claim based on team.hqCount, not client request
5. WHEN an HQ is placed via claim_star, THE Server SHALL set star.hq = true and increment team.hqCount

### Requirement 13: Black Hole Mechanics (Min/Max Requirement, Explosion)

**User Story:** As a player, I want black holes to work correctly with their connection requirements, so that they explode connections when the requirement is met.

#### Acceptance Criteria

1. WHEN a map is loaded, THE System SHALL parse black hole stars with format [x, y, 3, minReq, maxReq]
2. DURING the planning stage (before game starts), THE UI SHALL display black hole requirements as "min-max" range
3. WHEN the game starts, THE Server SHALL randomly set each black hole's actual requirement between min and max (inclusive)
4. WHEN a black hole has exactly its requirement number of connections from the same team, THE black hole SHALL activate
5. WHEN a black hole activates, THE System SHALL "explode" (destroy) all connected stars of the triggering team
6. WHEN counting black hole connections, THE System SHALL allow overlapping paths (same star can be part of multiple connections)
7. WHEN a black hole activates, THE visual explosion effect SHALL occur immediately
8. THE connection count SHALL be recalculated after any move that could affect black hole connections

### Requirement 14: Wormhole Mechanics (Min/Max Requirement, Game End)

**User Story:** As a player, I want wormholes to work correctly with their connection requirements, so that meeting the requirement ends the game.

#### Acceptance Criteria

1. WHEN a map is loaded, THE System SHALL parse wormhole stars with format [x, y, 4, minReq, maxReq]
2. DURING the planning stage (before game starts), THE UI SHALL display wormhole requirements as "min-max" range
3. WHEN the game starts, THE Server SHALL randomly set each wormhole's actual requirement between min and max (inclusive)
4. WHEN a wormhole has exactly its requirement number of non-overlapping path connections from the same team, THE wormhole SHALL activate
5. WHEN a wormhole activates, THE game SHALL immediately end with the activating team as winner
6. WHEN counting wormhole connections, THE System SHALL NOT allow overlapping paths (each star can only be part of one path)
7. WHEN checking wormhole paths, THE System SHALL use proper pathfinding that excludes already-used stars
8. THE wormhole check SHALL run after any move that could create connections

### Requirement 15: Protected Star Logic

**User Story:** As a player, I want star protection to work correctly based on black hole requirements, so that protection mechanics are reliable.

#### Acceptance Criteria

1. WHEN a black hole's team requirement is met, THE connected stars SHALL become protected
2. WHEN a black hole's team requirement is not met, THE connected stars SHALL NOT be protected
3. WHEN protection status changes, THE visual indicator SHALL update immediately
4. WHEN a protected star is targeted for stealing, THE Server SHALL reject the steal
5. THE protection status SHALL be recalculated after any move affecting black hole connections

### Requirement 16: Game Configuration Consistency

**User Story:** As a game administrator, I want game configuration to be consistent between server and all clients, so that rules are applied uniformly.

#### Acceptance Criteria

1. WHEN a game is created, THE Server SHALL store the authoritative game configuration
2. WHEN a client joins, THE Server SHALL send the current game configuration
3. WHEN settings are updated via admin panel, THE Server SHALL broadcast the update to all clients
4. THE Server SHALL use gameConfig values for all validation (not hardcoded defaults)
5. WHEN validating moves, THE Server SHALL reference gameConfig.headquarters, gameConfig.steals, gameConfig.moves

### Requirement 17: Bot Initialization from Admin Panel

**User Story:** As a game administrator, I want bots configured in the admin panel to be properly initialized in the game, so that bot settings are respected.

#### Acceptance Criteria

1. WHEN bots are configured in admin panel, THE configuration SHALL be sent to server on game creation
2. WHEN the game starts, THE Server SHALL include bot configuration in the game_started message
3. WHEN the client receives bot configuration, THE Client SHALL create AIBot instances with correct parameters
4. WHEN creating an AIBot, THE System SHALL use the configured type, teamIndex, and aggression values
5. THE Bot's team assignment SHALL match the teamIndex specified in configuration
6. WHEN a bot is assigned to a team, THE bot's moves SHALL count against that team's resources
7. THE Bot SHALL be included in the teamSize calculation for move distribution

### Requirement 18: Map Data Parsing for Special Stars

**User Story:** As a game administrator, I want map JSON data to be correctly parsed for black holes and wormholes, so that special star mechanics work properly.

#### Acceptance Criteria

1. WHEN loading a map JSON, THE System SHALL parse the stars array where each star is [x, y, type, minReq?, maxReq?]
2. WHEN type equals 3 (black hole), THE System SHALL read minReq and maxReq from indices 3 and 4
3. WHEN type equals 4 (wormhole), THE System SHALL read minReq and maxReq from indices 3 and 4
4. IF minReq or maxReq are not provided, THE System SHALL use default values (e.g., minReq=maxReq=3)
5. WHEN displaying special stars in planning phase, THE UI SHALL show the requirement range
6. WHEN the game starts, THE Server SHALL generate random requirements and broadcast them to all clients

### Requirement 19: Dynamic Team Color Configuration and Synchronization

**User Story:** As a game administrator, I want team colors to be configurable from the admin panel and synchronized to all game clients, so that players see consistent team colors that match the admin's configuration.

#### Acceptance Criteria

1. WHEN the admin panel configures team colors, THE Server SHALL store the team color configuration as part of the game room state
2. WHEN a game client connects, THE Server SHALL send the current team color configuration to the client
3. WHEN team colors are updated in the admin panel, THE Server SHALL broadcast the updated colors to all connected clients
4. WHEN the client receives team color configuration, THE Client SHALL update all UI elements using those colors (leaderboard, header, star rendering, cursor colors)
5. THE Client SHALL use a centralized TEAM_COLORS array that can be dynamically updated from server configuration
6. WHEN rendering the leaderboard/scoreboard, THE Client SHALL use the server-provided team colors, not hardcoded values
7. WHEN displaying the player's team color in the header, THE Client SHALL use the server-provided color for that team index

### Requirement 20: Player-to-Team Color Association

**User Story:** As a player, I want my team color to be correctly displayed everywhere in the game UI, so that I can easily identify my team and other teams.

#### Acceptance Criteria

1. WHEN a player is assigned to a team, THE Server SHALL associate that player with the team's configured color
2. WHEN displaying the player's team in the header, THE Client SHALL show the correct team color name and use that color for styling
3. WHEN rendering player cursors in multiplayer, THE Client SHALL use the player's team color
4. WHEN rendering click effects from other players, THE Client SHALL use the originating player's team color
5. WHEN a player's team assignment changes, THE Client SHALL immediately update all UI elements to reflect the new team color
6. THE player's team color SHALL be consistent across: header display, leaderboard highlight, cursor color, and click effects

### Requirement 21: Leaderboard Team Color Rendering

**User Story:** As a player, I want the in-game leaderboard to display team colors that match the admin configuration, so that scores are visually associated with the correct teams.

#### Acceptance Criteria

1. WHEN rendering the leaderboard, THE Client SHALL use the team color from the synchronized configuration for each team row
2. WHEN a team's score changes, THE leaderboard SHALL update the score while maintaining the correct team color
3. WHEN the player's own team is displayed, THE leaderboard SHALL highlight that row with the team's color
4. WHEN team colors are updated mid-game, THE leaderboard SHALL re-render with the new colors
5. THE leaderboard score bar width SHALL be proportional to the team's score, using the team's configured color
6. WHEN displaying steal counts in the leaderboard, THE Client SHALL use the team's color for the steal indicator

### Requirement 22: Student/Player Identity and Team Color Mapping

**User Story:** As a game administrator using the color optimizer, I want player identities (students) to be correctly mapped to their assigned team colors, so that accessibility-optimized colors are properly applied.

#### Acceptance Criteria

1. WHEN a player joins with a studentId, THE Server SHALL store the studentId in the player state
2. WHEN the admin assigns a player to a team via the color optimizer, THE Server SHALL update that player's team assignment
3. WHEN team colors are optimized for color blindness accessibility, THE new colors SHALL be broadcast to all clients
4. WHEN a client receives updated team colors, THE Client SHALL update the TEAM_CONFIGS array and re-render all team-colored elements
5. THE player's studentId SHALL be preserved across team reassignments
6. WHEN displaying player information in the admin panel, THE System SHALL show the player's name, studentId, and current team color
