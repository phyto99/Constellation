// Server-Side Bot AI for Star Conquest
// This file contains all bot decision-making logic that runs on the server

// Star types (matching client)
const T = {
    N: 0, // Normal
    C: 1, // Cluster
    B: 2, // Black hole
    W: 3  // Wormhole
};

// Bot type configurations
const AI_BOT_TYPES = {
    HAL: { name: 'HAL', description: 'Steady, logical, and dispassionate', icon: '🤖', strategy: 'defensive' },
    CAESAR: { name: 'Caesar', description: 'Thoughtful and tactical', icon: '👑', strategy: 'tactical' },
    ATHENA: { name: 'Athena', description: 'Hits hard and fast', icon: '⚔️', strategy: 'aggressive' },
    ROBIN_HOOD: { name: 'Robin Hood', description: 'Steals from the rich', icon: '🏹', strategy: 'opportunistic' },
    EINSTEIN: { name: 'Einstein', description: 'Loves to study worm-holes', icon: '🧠', strategy: 'wormhole' },
    LORENZ: { name: 'Lorenz', description: 'An advocate of chaos', icon: '🌀', strategy: 'chaotic' },
    CUSTOM: { name: 'Custom', description: 'Create your own bot personality', icon: '✨', strategy: 'custom' }
};

// Bot AI Class (Server-Side)
class ServerAIBot {
    constructor(type, teamIndex, aggression = 5, customConfig = null) {
        this.type = type;
        this.teamIndex = teamIndex;
        this.aggression = Math.max(1, Math.min(9, aggression));
        this.customConfig = customConfig;

        // Bot configuration
        this.config = AI_BOT_TYPES[type] || AI_BOT_TYPES['HAL'];
        
        // Parse custom priorities if provided
        if (customConfig && customConfig.customPriorities) {
            try {
                this.customPriorities = new Function('return ' + customConfig.customPriorities)();
            } catch (e) {
                console.error('Error parsing customPriorities:', e);
                this.customPriorities = null;
            }
        }
        
        // Timing and delays
        this.lastMoveTime = 0;
        this.moveDelay = this.calculateMoveDelay();
        
        // State tracking
        this.hqPlaced = false;
        this.stealsUsed = 0;
        this.totalStealsThisRound = 0;
        this.consecutiveFailures = 0;
        this.specialStars = new Map();
        this.targetStars = new Set();
        this.strategicMemory = new Map();
        this.lastScorePosition = 0;

        // Performance: Cooldowns
        this.lastSuccessfulMoveTime = 0;
        this.lastFailedMoveTime = 0;
        this.successCooldown = 500;
        this.failureCooldown = 1000;

        // Performance: Cached game state
        this.cachedGameState = null;
        this.cachedGameStateTime = 0;

        // Server integration
        this.playerId = null;
        this.movesLeft = 0;
        this.lastRejectedMove = null;
    }

    calculateMoveDelay() {
        const baseDelay = 1800 - (this.aggression * 150);
        const randomVariation = Math.random() * 200 - 100;
        return Math.max(500, baseDelay + randomVariation);
    }

    shouldMakeMove(currentTime, gameState) {
        // Check cooldowns
        const timeSinceSuccess = currentTime - this.lastSuccessfulMoveTime;
        const timeSinceFailure = currentTime - this.lastFailedMoveTime;
        
        if (timeSinceSuccess < this.successCooldown) return false;
        if (timeSinceFailure < this.failureCooldown) return false;
        
        // Exponential backoff for failures
        if (this.consecutiveFailures > 0) {
            const backoffTime = this.failureCooldown * Math.pow(1.5, Math.min(this.consecutiveFailures, 4));
            if (timeSinceFailure < backoffTime) return false;
        }

        // Check move delay
        if (currentTime - this.lastMoveTime < this.moveDelay) return false;

        // Check steal limits
        const maxStealsPerRound = this.calculateMaxSteals(gameState);
        if (this.totalStealsThisRound >= maxStealsPerRound) {
            return true; // Can still make regular moves
        }

        // Time-based urgency
        const timeRatio = gameState.timeLeft / gameState.roundLength;
        if (timeRatio < 0.2 && this.aggression >= 7) {
            return currentTime - this.lastMoveTime > this.moveDelay * 0.4;
        }

        return true;
    }

    calculateMaxSteals(gameState) {
        const baseLimit = Math.floor(this.aggression / 2);
        const position = gameState.myPosition;
        let positionMultiplier = 1.0;

        if (position === 1) positionMultiplier = 0.3;
        else if (position === 2) positionMultiplier = 0.6;
        else if (position >= 5) positionMultiplier = 1.4;

        const strategyMultipliers = {
            'defensive': 0.6,
            'tactical': 1.2,
            'aggressive': 2.0,
            'opportunistic': 1.5,
            'wormhole': 0.8,
            'chaotic': 1.3
        };

        const finalLimit = Math.floor(baseLimit * positionMultiplier * strategyMultipliers[this.config.strategy]);
        return Math.max(0, Math.min(finalLimit, gameState.stealsLeft));
    }

    analyzeGameState(game, multipliers) {
        // Use cached game state if recent
        const now = Date.now();
        if (this.cachedGameState && (now - this.cachedGameStateTime) < 1000) {
            return this.cachedGameState;
        }
        
        // Update special stars cache
        this.specialStars.clear();
        game.stars.forEach((star, index) => {
            if (star.ty === T.W) this.specialStars.set(index, 'wormhole');
            else if (star.ty === T.B) this.specialStars.set(index, 'blackhole');
            else if (star.ty === T.C) this.specialStars.set(index, 'cluster');
        });

        // Get current team state
        const team = game.teams[this.teamIndex];
        const teamStars = game.stars.filter(s => s.tm === this.teamIndex);
        const teamHQs = teamStars.filter(s => s.hq);

        // Calculate team rankings
        const allScores = game.teams.map((t, i) => ({ score: t.s, index: i }))
            .sort((a, b) => b.score - a.score);
        const myPosition = allScores.findIndex(t => t.index === this.teamIndex) + 1;

        const gameState = {
            game,
            team,
            teamStars,
            teamHQs,
            multipliers,
            timeLeft: game.t,
            roundLength: game.RT,
            stealsLeft: team.st,
            myPosition,
            allScores,
            roundProgress: 1 - (game.t / game.RT),
            currentRound: game.r,
            totalRounds: game.TR,
            gameProgress: game.r / game.TR
        };
        
        this.cachedGameState = gameState;
        this.cachedGameStateTime = now;
        
        return gameState;
    }

    makeMove(game, multipliers, adjacencyCache) {
        if (this.movesLeft <= 0) return null;
        if (!this.shouldMakeMove(Date.now(), game)) return null;

        const gameState = this.analyzeGameState(game, multipliers);
        let move = null;

        // Strategy-based decision making
        switch (this.config.strategy) {
            case 'defensive':
                move = this.defensiveStrategy(game, gameState, adjacencyCache);
                break;
            case 'tactical':
                move = this.tacticalStrategy(game, gameState, adjacencyCache);
                break;
            case 'aggressive':
                move = this.aggressiveStrategy(game, gameState, adjacencyCache);
                break;
            case 'opportunistic':
                move = this.opportunisticStrategy(game, gameState, adjacencyCache);
                break;
            case 'wormhole':
                move = this.wormholeStrategy(game, gameState, adjacencyCache);
                break;
            case 'chaotic':
                move = this.chaoticStrategy(game, gameState, adjacencyCache);
                break;
            case 'custom':
                move = this.customStrategy(game, gameState, adjacencyCache);
                break;
        }

        if (move) {
            this.lastMoveTime = Date.now();
            this.moveDelay = this.calculateMoveDelay();
            return move;
        } else {
            this.lastFailedMoveTime = Date.now();
            this.consecutiveFailures++;
        }

        return null;
    }

    defensiveStrategy(game, gameState, adjacencyCache) {
        const m = gameState.multipliers;
        const desperation = Math.max(0, gameState.myPosition - 2);
        const stealsLeft = gameState.stealsLeft;
        const stealScarcity = stealsLeft <= 3 ? 2 : (stealsLeft <= 7 ? 1.5 : 1);
        const gameProgress = gameState.gameProgress;
        const lateGameUrgency = gameProgress > 0.7 ? 1.5 : 1;
        const earlyGameCaution = gameProgress < 0.3 ? 1.2 : 1;

        const priorities = [
            { action: 'hq', weight: gameState.teamHQs.length < game.HM ? 200 * earlyGameCaution : 0 },
            { action: 'connect', weight: (150 + (m.hq > 0 ? m.hq * 20 : 0) + (stealsLeft <= 5 ? 50 : 0)) * earlyGameCaution },
            { action: 'expand', weight: (Math.max(10, 80 - desperation * 10) + (stealsLeft <= 3 ? 40 : 0)) * (gameProgress < 0.5 ? 1.3 : 0.8) },
            { action: 'steal', weight: desperation > 3 && stealsLeft > 2 ? (desperation * 15 * lateGameUrgency) / stealScarcity : 0 }
        ];

        return this.executeTopPriority(game, gameState, priorities, adjacencyCache);
    }

    tacticalStrategy(game, gameState, adjacencyCache) {
        const m = gameState.multipliers;
        const roundProgress = gameState.roundProgress;
        const isWinning = gameState.myPosition <= 2;
        const stealsLeft = gameState.stealsLeft;
        const gameProgress = gameState.gameProgress;
        const midGameBonus = gameProgress > 0.3 && gameProgress < 0.7 ? 1.3 : 1;
        const endGameDesperation = gameProgress > 0.8 ? 2.0 : 1;

        const priorities = [
            { action: 'hq', weight: gameState.teamHQs.length < game.HM ? 180 * (gameProgress < 0.4 ? 1.2 : 0.8) : 0 },
            {
                action: 'steal', weight: this.totalStealsThisRound < this.calculateMaxSteals(gameState) && stealsLeft > 1 ?
                    ((isWinning ? 40 : 120) + (roundProgress > 0.7 ? 60 : 0)) * (stealsLeft <= 3 ? 0.5 : 1) * midGameBonus * endGameDesperation : 0
            },
            { action: 'expand', weight: (100 + (m.count > 0 ? m.count * 0.2 : -20) + (stealsLeft <= 2 ? 50 : 0)) * (gameProgress < 0.6 ? 1.2 : 0.9) },
            { action: 'connect', weight: (90 + (m.distance > 0 ? m.distance * 10 : -30)) * midGameBonus }
        ];

        return this.executeTopPriority(game, gameState, priorities, adjacencyCache);
    }

    aggressiveStrategy(game, gameState, adjacencyCache) {
        const timeLeft = gameState.timeLeft / gameState.roundLength;
        const behindMultiplier = Math.max(1, gameState.myPosition - 1);
        const stealsLeft = gameState.stealsLeft;
        const stealUrgency = stealsLeft <= 5 ? 1.5 : 1;
        const gameProgress = gameState.gameProgress;
        const earlyGameRush = gameProgress < 0.4 ? 1.4 : 1;
        const finalRoundsRage = gameProgress > 0.85 ? 2.5 : 1;

        const priorities = [
            {
                action: 'steal', weight: this.totalStealsThisRound < this.calculateMaxSteals(gameState) && stealsLeft > 0 ?
                    (150 + behindMultiplier * 30 + (timeLeft < 0.3 ? 100 : 0)) * stealUrgency * earlyGameRush * finalRoundsRage : 0
            },
            { action: 'hq', weight: gameState.teamHQs.length < game.HM ? 140 * (gameProgress < 0.3 ? 1.1 : 0.9) : 0 },
            { action: 'expand', weight: (120 + (timeLeft > 0.7 ? 50 : 0) + (stealsLeft === 0 ? 80 : 0)) * earlyGameRush },
            { action: 'connect', weight: 30 + (stealsLeft <= 2 ? 40 : 0) + (gameProgress > 0.8 ? 30 : 0) }
        ];

        return this.executeTopPriority(game, gameState, priorities, adjacencyCache);
    }

    opportunisticStrategy(game, gameState, adjacencyCache) {
        const leadingTeamScore = gameState.allScores[0].score;
        const myScore = gameState.team.s;
        const gapToLeader = Math.max(0, leadingTeamScore - myScore);
        const desperationLevel = Math.floor(gapToLeader / 1000);
        const stealsLeft = gameState.stealsLeft;
        const stealEfficiency = stealsLeft <= 3 ? 2 : 1;
        const gameProgress = gameState.gameProgress;
        const midGameOpportunism = gameProgress > 0.25 && gameProgress < 0.75 ? 1.3 : 1;
        const lateGameDesperation = gameProgress > 0.8 ? 1.8 : 1;

        const priorities = [
            {
                action: 'steal', weight: this.totalStealsThisRound < this.calculateMaxSteals(gameState) && stealsLeft > 0 ?
                    ((130 + desperationLevel * 20) / stealEfficiency) * midGameOpportunism * lateGameDesperation : 0
            },
            { action: 'hq', weight: gameState.teamHQs.length < game.HM ? 120 * (gameProgress < 0.4 ? 1.1 : 0.9) : 0 },
            { action: 'expand', weight: (80 - desperationLevel * 5 + (stealsLeft <= 2 ? 60 : 0)) * (gameProgress < 0.5 ? 1.2 : 0.8) },
            { action: 'connect', weight: (60 + (stealsLeft <= 3 ? 40 : 0)) * (gameProgress > 0.6 ? 1.2 : 1) }
        ];

        return this.executeTopPriority(game, gameState, priorities, adjacencyCache);
    }

    wormholeStrategy(game, gameState, adjacencyCache) {
        const myWormholes = gameState.teamStars.filter(s => s.ty === T.W).length;
        const wormholeBonus = myWormholes * 50;

        const priorities = [
            { action: 'hq', weight: gameState.teamHQs.length < game.HM ? 130 : 0 },
            { action: 'wormhole', weight: 200 + wormholeBonus },
            {
                action: 'steal', weight: this.totalStealsThisRound < this.calculateMaxSteals(gameState) ?
                    (myWormholes >= 1 ? 90 : 40) : 0
            },
            { action: 'connect', weight: 100 + wormholeBonus },
            { action: 'expand', weight: 70 }
        ];

        return this.executeTopPriority(game, gameState, priorities, adjacencyCache);
    }

    chaoticStrategy(game, gameState, adjacencyCache) {
        const chaosLevel = Math.sin(Date.now() * 0.003) * 0.5 + 0.5;
        const roundChaos = Math.sin(gameState.roundProgress * Math.PI * 4) * 0.3 + 0.7;
        const totalChaos = chaosLevel * roundChaos;

        const priorities = [
            { action: 'hq', weight: gameState.teamHQs.length < game.HM ? 110 : 0 },
            {
                action: 'steal', weight: this.totalStealsThisRound < this.calculateMaxSteals(gameState) ?
                    60 + totalChaos * 100 : 0
            },
            { action: 'disrupt', weight: totalChaos * 150 },
            { action: 'expand', weight: 50 + (1 - totalChaos) * 80 },
            { action: 'connect', weight: 80 - totalChaos * 50 }
        ];

        return this.executeTopPriority(game, gameState, priorities, adjacencyCache);
    }

    customStrategy(game, gameState, adjacencyCache) {
        if (this.customPriorities) {
            return this.executeTopPriority(game, gameState, this.customPriorities(gameState), adjacencyCache);
        }
        
        // Default balanced strategy
        const priorities = [
            { action: 'hq', weight: gameState.teamHQs.length < game.HM ? 150 : 0 },
            { action: 'steal', weight: this.totalStealsThisRound < this.calculateMaxSteals(gameState) ? 80 : 0 },
            { action: 'expand', weight: 90 },
            { action: 'connect', weight: 70 }
        ];

        return this.executeTopPriority(game, gameState, priorities, adjacencyCache);
    }

    executeTopPriority(game, gameState, priorities, adjacencyCache) {
        const validPriorities = priorities.filter(p => p.weight > 0);
        if (validPriorities.length === 0) return null;

        const shuffledPriorities = this.weightedRandomShuffle(validPriorities, gameState);

        for (const priority of shuffledPriorities) {
            const move = this.tryAction(game, gameState, priority.action, adjacencyCache);
            if (move) return move;
        }

        return null;
    }

    weightedRandomShuffle(priorities, gameState) {
        const gameProgress = gameState ? gameState.gameProgress : 0.5;
        const totalRounds = gameState ? gameState.totalRounds : 10;
        const randomnessFactor = Math.min(2.0, totalRounds / 20);
        const progressRandomness = 0.5 + (gameProgress * 0.5);
        const finalRandomness = randomnessFactor * progressRandomness;

        const adjustedPriorities = priorities.map(p => ({
            ...p,
            weight: Math.pow(p.weight, 1 / finalRandomness)
        }));

        const result = [];
        const remaining = [...adjustedPriorities];

        while (remaining.length > 0) {
            const currentTotal = remaining.reduce((sum, p) => sum + p.weight, 0);
            let random = Math.random() * currentTotal;

            for (let i = 0; i < remaining.length; i++) {
                random -= remaining[i].weight;
                if (random <= 0) {
                    result.push(remaining.splice(i, 1)[0]);
                    break;
                }
            }
        }

        return result;
    }

    tryAction(game, gameState, action, adjacencyCache) {
        switch (action) {
            case 'hq': return this.tryPlaceHQ(game, gameState, adjacencyCache);
            case 'steal': return this.trySteal(game, gameState, adjacencyCache);
            case 'expand': return this.tryExpand(game, gameState, adjacencyCache);
            case 'connect': return this.tryConnect(game, gameState, adjacencyCache);
            case 'wormhole': return this.tryWormhole(game, gameState, adjacencyCache);
            case 'disrupt': return this.tryDisrupt(game, gameState, adjacencyCache);
            default: return null;
        }
    }

    tryPlaceHQ(game, gameState, adjacencyCache) {
        const maxCandidates = Math.min(game.stars.length, 100);
        const candidates = [];
        
        const step = Math.max(1, Math.floor(game.stars.length / maxCandidates));
        for (let i = 0; i < game.stars.length && candidates.length < maxCandidates; i += step) {
            const star = game.stars[i];
            if (star.tm === -1 && !star.destroyed) {
                candidates.push({ star, index: i });
            }
        }

        if (candidates.length === 0) return null;

        let best = null;
        let bestScore = -1;
        const centerX = game.MW / 2, centerY = game.MH / 2;

        candidates.forEach(({ star, index }) => {
            const connections = adjacencyCache[index] || [];
            let score = connections.length * 2;

            if (star.ty === T.C) score += 8;
            if (star.ty === T.W) score += 5;

            const distFromCenter = Math.sqrt((star.x - centerX) ** 2 + (star.y - centerY) ** 2);
            score += Math.max(0, 10 - distFromCenter * 0.1);

            if (score > bestScore) {
                bestScore = score;
                best = index;
            }
        });

        return best !== null ? { type: 'hq', target: best } : null;
    }

    trySteal(game, gameState, adjacencyCache) {
        if (this.totalStealsThisRound >= this.calculateMaxSteals(gameState)) return null;
        if (gameState.stealsLeft <= 0) return null;

        const maxCandidates = Math.min(game.stars.length, 80);
        const candidates = [];
        
        const myStarIndices = new Set();
        game.stars.forEach((star, idx) => {
            if (star.tm === this.teamIndex) myStarIndices.add(idx);
        });

        for (const myIdx of myStarIndices) {
            if (candidates.length >= maxCandidates) break;
            const connections = adjacencyCache[myIdx] || [];
            for (const adjIdx of connections) {
                const star = game.stars[adjIdx];
                if (star.tm !== -1 && star.tm !== this.teamIndex && 
                    !star.hq && !star.pr && !star.destroyed &&
                    star.ty !== T.C && star.ty !== T.B && 
                    !this.isRecentlyRejected(adjIdx)) {
                    candidates.push({ star, index: adjIdx });
                    if (candidates.length >= maxCandidates) break;
                }
            }
        }

        if (candidates.length < maxCandidates / 2) {
            const step = Math.max(1, Math.floor(game.stars.length / maxCandidates));
            for (let i = 0; i < game.stars.length && candidates.length < maxCandidates; i += step) {
                const star = game.stars[i];
                if (star.tm !== -1 && star.tm !== this.teamIndex && 
                    !star.hq && !star.pr && !star.destroyed &&
                    star.ty !== T.C && star.ty !== T.B && 
                    !this.isRecentlyRejected(i)) {
                    candidates.push({ star, index: i });
                }
            }
        }

        if (candidates.length === 0) return null;

        const stealThreshold = this.calculateStealThreshold(gameState);
        let best = null;
        let bestValue = -1;
        const goodEnoughValue = stealThreshold * 2;

        for (const { star, index } of candidates) {
            const stealValue = this.calculateStealValue(game, gameState, index, star, adjacencyCache);

            if (stealValue >= stealThreshold && stealValue > bestValue) {
                bestValue = stealValue;
                best = index;
                
                if (bestValue >= goodEnoughValue) break;
            }
        }

        return best !== null ? { type: 'steal', target: best } : null;
    }

    isRecentlyRejected(starIndex) {
        if (!this.lastRejectedMove) return false;
        if (this.lastRejectedMove.starIndex !== starIndex) return false;
        return (Date.now() - this.lastRejectedMove.timestamp) < 2000;
    }

    calculateStealThreshold(gameState) {
        const stealsLeft = gameState.stealsLeft;
        const totalSteals = gameState.game.S;
        const stealRatio = stealsLeft / totalSteals;
        const gameProgress = gameState.gameProgress;

        let baseThreshold = 150;
        if (stealRatio <= 0.2) baseThreshold = 800;
        else if (stealRatio <= 0.4) baseThreshold = 500;
        else if (stealRatio <= 0.7) baseThreshold = 300;

        let roundModifier = 1.0;
        if (gameProgress < 0.3) {
            roundModifier = 1.3;
        } else if (gameProgress > 0.8) {
            roundModifier = 0.6;
        } else if (gameProgress > 0.6) {
            roundModifier = 0.8;
        }

        return baseThreshold * roundModifier;
    }

    calculateStealValue(game, gameState, starIndex, star, adjacencyCache) {
        const connections = adjacencyCache[starIndex] || [];
        let value = 100;

        const myConnections = connections.filter(idx => game.stars[idx].tm === this.teamIndex).length;
        value += myConnections * 50;

        const enemyConnections = connections.filter(idx => {
            const s = game.stars[idx];
            return s.tm !== -1 && s.tm !== this.teamIndex;
        }).length;
        value += enemyConnections * 30;

        if (star.ty === T.W) value += 100;
        if (star.ty === T.C) value += 80;

        const targetTeamScore = gameState.allScores.find(s => s.index === star.tm)?.score || 0;
        const myScore = gameState.team.s;
        if (targetTeamScore > myScore) {
            value += Math.min(200, (targetTeamScore - myScore) / 10);
        }

        const leadingTeam = gameState.allScores[0].index;
        if (star.tm === leadingTeam) {
            value += 150;
        }

        return value;
    }

    tryExpand(game, gameState, adjacencyCache) {
        const maxCandidates = Math.min(game.stars.length, 100);
        const candidates = [];
        
        const myStarIndices = new Set();
        game.stars.forEach((star, idx) => {
            if (star.tm === this.teamIndex) myStarIndices.add(idx);
        });

        for (const myIdx of myStarIndices) {
            if (candidates.length >= maxCandidates) break;
            const connections = adjacencyCache[myIdx] || [];
            for (const adjIdx of connections) {
                const star = game.stars[adjIdx];
                if (star.tm === -1 && !star.destroyed && !this.isRecentlyRejected(adjIdx)) {
                    candidates.push({ star, index: adjIdx, fromIndex: myIdx });
                    if (candidates.length >= maxCandidates) break;
                }
            }
        }

        if (candidates.length === 0) return null;

        let best = null;
        let bestScore = -1;

        for (const { star, index } of candidates) {
            const connections = adjacencyCache[index] || [];
            let score = connections.length * 10;

            if (star.ty === T.C) score += 50;
            if (star.ty === T.W) score += 40;

            const myConnections = connections.filter(idx => game.stars[idx].tm === this.teamIndex).length;
            score += myConnections * 30;

            if (score > bestScore) {
                bestScore = score;
                best = index;
            }
        }

        return best !== null ? { type: 'expand', target: best } : null;
    }

    tryConnect(game, gameState, adjacencyCache) {
        const myStars = [];
        game.stars.forEach((star, idx) => {
            if (star.tm === this.teamIndex) {
                myStars.push({ star, index: idx });
            }
        });

        if (myStars.length < 2) return null;

        let bestPair = null;
        let bestScore = -1;

        for (let i = 0; i < Math.min(myStars.length, 50); i++) {
            const star1 = myStars[i];
            const connections1 = adjacencyCache[star1.index] || [];

            for (const adjIdx of connections1) {
                const adjStar = game.stars[adjIdx];
                if (adjStar.tm === -1 && !adjStar.destroyed && !this.isRecentlyRejected(adjIdx)) {
                    const connections2 = adjacencyCache[adjIdx] || [];
                    const connectsToMyTeam = connections2.filter(idx => 
                        game.stars[idx].tm === this.teamIndex && idx !== star1.index
                    ).length;

                    if (connectsToMyTeam > 0) {
                        let score = connectsToMyTeam * 100;
                        
                        if (adjStar.ty === T.W) score += 80;
                        if (adjStar.ty === T.C) score += 60;
                        
                        if (star1.star.hq) score += 50;

                        if (score > bestScore) {
                            bestScore = score;
                            bestPair = adjIdx;
                        }
                    }
                }
            }
        }

        return bestPair !== null ? { type: 'connect', target: bestPair } : null;
    }

    tryWormhole(game, gameState, adjacencyCache) {
        const wormholes = [];
        game.stars.forEach((star, idx) => {
            if (star.ty === T.W && star.tm === -1 && !star.destroyed && !this.isRecentlyRejected(idx)) {
                wormholes.push({ star, index: idx });
            }
        });

        if (wormholes.length === 0) return null;

        let best = null;
        let bestScore = -1;

        for (const { star, index } of wormholes) {
            const connections = adjacencyCache[index] || [];
            let score = 200;

            const myConnections = connections.filter(idx => game.stars[idx].tm === this.teamIndex).length;
            score += myConnections * 100;

            const neutralConnections = connections.filter(idx => game.stars[idx].tm === -1).length;
            score += neutralConnections * 20;

            if (score > bestScore) {
                bestScore = score;
                best = index;
            }
        }

        return best !== null ? { type: 'wormhole', target: best } : null;
    }

    tryDisrupt(game, gameState, adjacencyCache) {
        const maxCandidates = Math.min(game.stars.length, 60);
        const candidates = [];
        
        const step = Math.max(1, Math.floor(game.stars.length / maxCandidates));
        for (let i = 0; i < game.stars.length && candidates.length < maxCandidates; i += step) {
            const star = game.stars[i];
            if (star.tm === -1 && !star.destroyed && !this.isRecentlyRejected(i)) {
                candidates.push({ star, index: i });
            }
        }

        if (candidates.length === 0) return null;

        let best = null;
        let bestScore = -1;

        for (const { star, index } of candidates) {
            const connections = adjacencyCache[index] || [];
            
            const enemyConnections = connections.filter(idx => {
                const s = game.stars[idx];
                return s.tm !== -1 && s.tm !== this.teamIndex;
            }).length;

            if (enemyConnections > 0) {
                let score = enemyConnections * 50;
                
                const leadingTeam = gameState.allScores[0].index;
                const leadingTeamConnections = connections.filter(idx => 
                    game.stars[idx].tm === leadingTeam
                ).length;
                score += leadingTeamConnections * 80;

                if (score > bestScore) {
                    bestScore = score;
                    best = index;
                }
            }
        }

        return best !== null ? { type: 'disrupt', target: best } : null;
    }

    onMoveSuccess() {
        this.lastSuccessfulMoveTime = Date.now();
        this.consecutiveFailures = 0;
    }

    onMoveFailure() {
        this.lastFailedMoveTime = Date.now();
        this.consecutiveFailures++;
    }

    onRoundStart() {
        this.totalStealsThisRound = 0;
    }
}

module.exports = { ServerAIBot, T, AI_BOT_TYPES };
