class Board {
    width: number;
    height: number;

    // We assign default values (10) right here in the constructor parameters
    constructor(width: number = 8, height: number = 8) {
        this.width = width;
        this.height = height;
    }

    // Rule 1: Is this coordinate actually on the board?
    // We specify that x and y must be numbers, and this will return a boolean (true/false)
    isValidPosition(x: number, y: number): boolean {
        return x >= 0 && x < this.width && y >= 0 && y < this.height;
    }

    // Rule 2: Did a bomb hit someone? 
    isDirectHit(bombX: number, bombY: number, playerX: number, playerY: number): boolean {
        return bombX === playerX && bombY === playerY;
    }

    // Future-proofing for Advanced Mode (Blast Radius!)
    // This returns a number representing grid tiles
    getDistance(x1: number, y1: number, x2: number, y2: number): number {
        return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
    }
}

export default Board;