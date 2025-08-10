# AI Player Strategy Breakdown - Detailed Logic Analysis

## Core AI Behavior System

### Timing & Aggression System
- **Move Speed**: Aggression level (0.1-1.0) determines move frequency
  - Low aggression (0.1): 2000ms delay between moves
  - High aggression (1.0): 100ms delay between moves
  - Random variation: ±200ms to prevent predictability
- **End-Game Rush**: High aggression bots (>0.7) speed up by 70% when <30% time remains
- **Move Validation**: Each bot checks timing constraints before attempting moves

### Game State Analysis (All Bots)
Before making any decision, each AI analyzes:
- **Special Stars**: Catalogs all wormholes, black holes, and clusters
- **Team Status**: Current score, steals remaining, HQs placed
- **Territory**: Stars owned, HQ locations, vulnerable positions
- **Time Pressure**: Remaining round time affects urgency

---

## Individual AI Strategies

### 🤖 HAL (Defensive Strategy)
**Philosophy**: "Steady, logical, and dispassionate" - Protect what you have

**HQ Placement Priority**:
1. **Connectivity Score**: Counts adjacent connections to star
2. **Cluster Bonus**: +5 points for cluster stars (high value)
3. **Best Connected**: Places HQ on most connected neutral star

**Decision Priority**:
1. **HQ Placement**: If under HQ limit, find best connected neutral star
2. **Protect Vulnerable Stars**: Identifies own stars with ≤1 friendly connection
3. **Defensive Expansion**: Captures neutral stars to strengthen territory

**Vulnerability Detection**:
- Scans own non-HQ stars
- Counts friendly connections to each star
- Prioritizes protecting isolated stars (≤1 connection)

---

### 👑 Caesar (Tactical Strategy)  
**Philosophy**: "Thoughtful and tactical" - Strategic positioning

**HQ Placement Priority**:
- Same as HAL but called "Strategic HQ Placement"
- Focuses on connectivity and cluster stars

**Decision Priority**:
1. **Strategic HQ**: Places HQs on well-connected positions
2. **High-Value Targets**: Prioritizes clusters and connected neutral stars
3. **Calculated Expansion**: Uses same logic as defensive but more aggressive

**Strategic Target Selection**:
- **Cluster Priority**: Cluster stars get +10 value points
- **Connectivity Bonus**: More connections = higher priority
- **Sorted by Value**: Always takes highest-scoring available target

---

### ⚡ Athena (Aggressive Strategy)
**Philosophy**: "Hits hard and fast" - Rapid expansion and stealing

**HQ Placement**: 
- Uses basic connectivity scoring (no special HQ logic)

**Decision Priority**:
1. **Steal First**: Always prioritizes stealing if steals available
2. **Rapid Expansion**: Captures neutral stars for quick territory growth
3. **No Defense**: Doesn't protect existing territory

**Enemy Target Selection**:
- **Cluster Priority**: Cluster stars get +10 points
- **Avoid HQs**: HQ stars get -20 points (too risky)
- **Regular Stars**: Base value of 1 point
- **Sorted by Risk/Reward**: Takes highest value, lowest risk targets

**Expansion Logic**:
- **Cluster Bonus**: +10 points for cluster stars
- **Connection Bonus**: More adjacent stars = higher priority
- **Pure Offense**: No consideration for defense

---

### 🏹 Robin Hood (Opportunistic Strategy)
**Philosophy**: "Steals from the rich" - Target leading teams

**HQ Placement**: 
- Uses basic connectivity scoring

**Decision Priority**:
1. **Rob the Rich**: Steals from top 2 scoring teams
2. **Valuable Undefended**: Captures high-value neutral stars

**Rich Target Selection**:
- **Identifies Leaders**: Sorts all teams by score, targets top 2
- **Avoids HQs**: Won't steal HQ stars (too protected)
- **Opportunistic**: Only steals from winning teams

**Value Assessment**:
- Same expansion logic as others (clusters + connections)
- Focuses on undefended valuable positions

---

### 🧠 Einstein (Wormhole Strategy)
**Philosophy**: "Loves to study worm-holes" - Scientific approach

**HQ Placement**: 
- Uses strategic placement (same as Caesar)

**Decision Priority**:
1. **Wormhole Science**: If 2+ wormholes exist, tries to connect them
2. **Pathfinding**: Uses breadth-first search to find connection routes
3. **Fallback**: Uses tactical strategy when wormholes unavailable

**Wormhole Connection Logic**:
- **Identifies All Wormholes**: Scans map for wormhole stars
- **Path Planning**: Calculates routes between wormhole pairs
- **Progressive Capture**: Takes next neutral/friendly star in path
- **Scientific Method**: Systematic approach to wormhole network building

**Pathfinding Algorithm**:
- Breadth-first search using adjacency cache
- Finds shortest path between wormhole pairs
- Prioritizes neutral stars in path for capture

---

### 🌪️ Lorenz (Chaotic Strategy)
**Philosophy**: "An advocate of chaos" - Unpredictable disruption

**HQ Placement**: 
- Uses basic connectivity scoring

**Decision Priority**:
1. **30% Chaos**: Random chance for disruptive moves
2. **Strategy Roulette**: Randomly picks defensive/aggressive/opportunistic
3. **Unpredictable**: Changes behavior each move

**Disruption Logic**:
- **Random Stealing**: Targets enemy stars to cause chaos
- **No Pattern**: Intentionally avoids predictable behavior
- **Mixed Strategies**: Combines elements from other AI types

**Randomization System**:
- 30% chance for pure disruption moves
- 70% chance for random strategy selection
- Creates unpredictable gameplay patterns

---

## Shared Helper Methods

### HQ Placement Logic (All Bots)
```
Score = Connection_Count + (Is_Cluster ? 5 : 0)
```
- Counts adjacent connections to star
- Bonus points for cluster stars
- Selects highest-scoring neutral star

### Enemy Target Prioritization
```
Score = (Is_Cluster ? 10 : 1) - (Is_HQ ? 20 : 0)
```
- Clusters are high value (+10)
- Regular stars are base value (1)
- HQs are avoided (-20 penalty)

### Expansion Target Scoring
```
Score = (Is_Cluster ? 10 : 1) + Connection_Count
```
- Clusters get bonus points
- More connections = higher priority
- Neutral stars only

### Vulnerability Detection
- Counts friendly connections to each owned star
- Stars with ≤1 friendly connection are "vulnerable"
- Used by defensive strategies for protection

## Key Differences Summary

| AI Type | HQ Strategy | Primary Focus | Stealing Behavior | Special Logic |
|---------|-------------|---------------|-------------------|---------------|
| HAL | Best Connected | Territory Defense | Minimal | Vulnerability Protection |
| Caesar | Strategic | Calculated Expansion | Moderate | High-Value Targeting |
| Athena | Basic | Rapid Expansion | Aggressive | Enemy Prioritization |
| Robin Hood | Basic | Steal from Leaders | Opportunistic | Rich Team Targeting |
| Einstein | Strategic | Wormhole Networks | Tactical | Pathfinding Algorithm |
| Lorenz | Basic | Chaos & Disruption | Random | Strategy Randomization |

Each AI has distinct personality through these different priority systems and decision-making logic!