# Requirements Document

## Introduction

This feature addresses critical game logic issues in the Star Conquest game related to bot behavior, black hole mechanics, wormhole activation, and visual updates. The fixes ensure consistent game rules between human players and AI bots, proper activation of special star mechanics, and accurate visual feedback.

## Requirements

### Requirement 1: Bot Black Hole Activation

**User Story:** As a player, I want black holes to activate immediately when bots connect them, so that the game mechanics work consistently regardless of whether humans or bots make the connections.

#### Acceptance Criteria

1. WHEN a bot connects black holes THEN the black hole SHALL activate immediately without requiring a player move
2. WHEN black holes are connected by bots THEN the visual updates SHALL occur in real-time
3. WHEN bot moves trigger black hole connections THEN the checkBlackholeActivation function SHALL be called automatically

### Requirement 2: Bot Stealing Restrictions

**User Story:** As a player, I want bots to follow the same stealing rules as human players, so that the game is fair and consistent.

#### Acceptance Criteria

1. WHEN bots attempt to steal stars THEN they SHALL NOT be able to steal cluster stars (type T.C)
2. WHEN bots attempt to steal stars THEN they SHALL NOT be able to steal headquarters (hq property is true)
3. WHEN bots evaluate steal targets THEN they SHALL filter out unstealable star types
4. WHEN bots use findEnemyTargets function THEN it SHALL exclude clusters and headquarters from potential targets

### Requirement 3: Wormhole Activation Fix

**User Story:** As a player, I want wormholes to activate properly regardless of distance or connection type, so that this game mechanic works reliably.

#### Acceptance Criteria

1. WHEN wormholes are connected by any valid path THEN they SHALL activate regardless of path length
2. WHEN wormholes are connected through HQ lines THEN they SHALL still activate properly
3. WHEN checkWormholeOptimized is called THEN it SHALL correctly detect all valid wormhole connections
4. WHEN wormhole paths are evaluated THEN distance limitations SHALL NOT prevent activation

### Requirement 4: Black Hole Protection Logic

**User Story:** As a player, I want black holes to only protect connected stars when the team requirement is met, so that the protection mechanic works as intended.

#### Acceptance Criteria

1. WHEN a black hole is connected to stars THEN it SHALL only protect those stars IF the team has met the requirement level
2. WHEN a black hole's requirement is not met THEN connected stars SHALL NOT receive protection
3. WHEN black hole requirements are checked THEN the color rotation indicator SHALL accurately reflect the requirement status
4. WHEN black hole connections are destroyed THEN protection SHALL be removed immediately

### Requirement 5: Bot Target Selection Logic

**User Story:** As a player, I want bots to only target stars that are actually stealable or claimable, so that bots behave intelligently and don't waste moves.

#### Acceptance Criteria

1. WHEN bots evaluate potential targets THEN they SHALL NOT target black holes for stealing
2. WHEN bots evaluate potential targets THEN they SHALL NOT target cluster stars for stealing
3. WHEN bots use aggressive or opportunistic strategies THEN they SHALL only target legitimately stealable stars
4. WHEN bots analyze game state THEN they SHALL distinguish between claimable neutral stars and unstealable owned stars

### Requirement 6: Black Hole Visual Updates

**User Story:** As a player, I want black hole color outlines to update immediately when connections change, so that I can see the current game state accurately.

#### Acceptance Criteria

1. WHEN black hole connections are established THEN the color outline SHALL update immediately
2. WHEN black hole connections are destroyed THEN the color outline SHALL update immediately
3. WHEN black hole requirements are met or lost THEN the visual indicator SHALL reflect the change without delay
4. WHEN the game state changes affecting black holes THEN the needsStarRedraw flag SHALL be set to trigger visual updates

### Requirement 7: Syntax Error Resolution

**User Story:** As a developer, I want the code to be free of syntax errors, so that the game runs without JavaScript errors.

#### Acceptance Criteria

1. WHEN the game loads THEN there SHALL be no JavaScript syntax errors in the console
2. WHEN the code is parsed THEN all brackets, parentheses, and braces SHALL be properly matched
3. WHEN functions are called THEN all function definitions SHALL be complete and syntactically correct
4. WHEN the game runs THEN no undefined function or variable errors SHALL occur