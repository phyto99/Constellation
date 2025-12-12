const { Schema, type, MapSchema, ArraySchema } = require('@colyseus/schema');

// Star schema - represents individual stars in the game
class StarSchema extends Schema {
    constructor() {
        super();
        this.x = 0;
        this.y = 0;
        this.ty = 0; // type: 0=normal, 1=wormhole, 2=cluster, 3=blackhole
        this.tm = -1; // team index (-1 for null/unclaimed)
        this.hq = false;
        this.pr = false; // protected
        this.destroyed = false;
        this.req = 0; // requirement for special stars
    }
}

type('number')(StarSchema.prototype, 'x');
type('number')(StarSchema.prototype, 'y');
type('number')(StarSchema.prototype, 'ty');
type('number')(StarSchema.prototype, 'tm');
type('boolean')(StarSchema.prototype, 'hq');
type('boolean')(StarSchema.prototype, 'pr');
type('boolean')(StarSchema.prototype, 'destroyed');
type('number')(StarSchema.prototype, 'req');

// Team schema - represents team resources and state
class TeamSchema extends Schema {
    constructor() {
        super();
        this.movesLeft = 0;
        this.stealsLeft = 0;
        this.hqCount = 0;
    }
}

type('number')(TeamSchema.prototype, 'movesLeft');
type('number')(TeamSchema.prototype, 'stealsLeft');
type('number')(TeamSchema.prototype, 'hqCount');

// Game state schema - root game state
class GameStateSchema extends Schema {
    constructor() {
        super();
        this.stars = new ArraySchema();
        this.teams = new ArraySchema();
        this.round = 1;
        this.initialized = false;
    }
}

type([StarSchema])(GameStateSchema.prototype, 'stars');
type([TeamSchema])(GameStateSchema.prototype, 'teams');
type('number')(GameStateSchema.prototype, 'round');
type('boolean')(GameStateSchema.prototype, 'initialized');

module.exports = {
    StarSchema,
    TeamSchema,
    GameStateSchema
};
