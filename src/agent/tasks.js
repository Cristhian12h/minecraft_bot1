import { readFileSync } from 'fs';
import { executeCommand } from './commands/index.js';
import { getPosition } from './library/world.js';
import settings from '../../settings.js';
import { CookingTaskInitiator } from './task_types/cooking_tasks.js';

/**
 * Validates the presence of required items in an agent's inventory
 * @param {Object} data - Task data containing target and quantity information
 * @param {Object} agent - Agent object with bot inventory
 * @returns {Object} Validation result with success status and missing items
 */
function checkItemPresence(data, agent) {
    // Helper function to check if target is a dictionary with quantities
    function isTargetDictionaryWithQuantities(target) {
        return typeof target === 'object' && 
               !Array.isArray(target) && 
               target !== null &&
               Object.values(target).every(value => typeof value === 'number');
    }

    // Convert any target format into a standardized dictionary
    function normalizeTargets(target) {
        if (typeof target === 'string') {
            // Single target case
            return { [target]: 1 };
        } else if (Array.isArray(target)) {
            // Array case - convert to dictionary with default quantity 1
            return target.reduce((acc, item) => {
                acc[item] = 1;
                return acc;
            }, {});
        } else if (typeof target === 'object' && target !== null) {
            // Already a dictionary - return as is
            return target;
        }
        throw new Error('Invalid target format');
    }

    // Normalize quantities to match target format
    function normalizeQuantities(targets, quantities) {
        if (quantities === undefined) {
            // If no quantities specified, default to 1 for each target
            return Object.keys(targets).reduce((acc, key) => {
                acc[key] = 1;
                return acc;
            }, {});
        } else if (typeof quantities === 'number') {
            // If single number provided, apply to all targets
            return Object.keys(targets).reduce((acc, key) => {
                acc[key] = quantities;
                return acc;
            }, {});
        } else if (typeof quantities === 'object' && quantities !== null) {
            // If quantities dictionary provided, use it directly
            return quantities;
        }
        throw new Error('Invalid number_of_target format');
    }

    try {
        // First normalize targets to always have a consistent format
        const targets = normalizeTargets(data.target);
        
        // Determine the required quantities
        const requiredQuantities = isTargetDictionaryWithQuantities(data.target) 
            ? data.target 
            : normalizeQuantities(targets, data.number_of_target);

        // Count items in inventory
        const inventoryCount = {};
        agent.bot.inventory.slots.forEach((slot) => {
            if (slot) {
                const itemName = slot.name.toLowerCase();
                inventoryCount[itemName] = (inventoryCount[itemName] || 0) + slot.count;
            }
        });

        // Check if all required items are present in sufficient quantities
        const missingItems = [];
        let allTargetsMet = true;

        for (const [item, requiredCount] of Object.entries(requiredQuantities)) {
            const itemName = item.toLowerCase();
            const currentCount = inventoryCount[itemName] || 0;
            
            if (currentCount < requiredCount) {
                allTargetsMet = false;
                missingItems.push({
                    item: itemName,
                    required: requiredCount,
                    current: currentCount,
                    missing: requiredCount - currentCount
                });
            }
        }

        return {
            success: allTargetsMet,
            missingItems: missingItems
        };

    } catch (error) {
        console.error('Error checking item presence:', error);
        return {
            success: false,
            missingItems: [],
            error: error.message
        };
    }
}

export class Task {
    constructor(agent, task_path, task_id) {
        this.agent = agent;
        this.data = null;
        this.taskTimeout = 300;
        this.taskStartTime = Date.now();
        this.validator = null;
        this.blocked_actions = [];
        if (task_path && task_id) {
            this.data = this.loadTask(task_path, task_id);
            this.taskTimeout = this.data.timeout || 300;
            this.taskStartTime = Date.now();
            this.task_type = this.data.type;
            
            // Set validator based on task_type
            if (this.task_type === 'cooking' || this.task_type === 'techtree') {
                this.validator = () => {
                    const result = checkItemPresence(this.data, this.agent);
                    return result.success;
                };
            } else {
                this.validator = null;
            }
            
            this.blocked_actions = this.data.blocked_actions || [];
            this.restrict_to_inventory = !!this.data.restrict_to_inventory;
            if (this.data.goal)
                this.blocked_actions.push('!endGoal');
            if (this.data.conversation)
                this.blocked_actions.push('!endConversation');
        }
        
        this.name = this.agent.name;
        this.available_agents = settings.profiles.map((p) => JSON.parse(readFileSync(p, 'utf8')).name);
    }

    loadTask(task_path, task_id) {
        try {
            const tasksFile = readFileSync(task_path, 'utf8');
            const tasks = JSON.parse(tasksFile);
            const task = tasks[task_id];
            if (!task) {
                throw new Error(`Task ${task_id} not found`);
            }
            if ((!task.agent_count || task.agent_count <= 1) && this.agent.count_id > 0) {
                task = null;
            }

            return task;
        } catch (error) {
            console.error('Error loading task:', error);
            process.exit(1);
        }
    }

    isDone() {
        if (this.validator && this.validator())
            return {"message": 'Task successful', "code": 2};
        
        if (this.taskTimeout) {
            const elapsedTime = (Date.now() - this.taskStartTime) / 1000;
            if (elapsedTime >= this.taskTimeout) {
                console.log('Task timeout reached. Task unsuccessful.');
                return {"message": 'Task timeout reached', "code": 4};
            }
        }
        return false;
    }

    async initBotTask() {
        await this.agent.bot.chat(`/clear ${this.name}`);
        console.log(`Cleared ${this.name}'s inventory.`);

        //wait for a bit so inventory is cleared
        await new Promise((resolve) => setTimeout(resolve, 500));

        if (this.data === null)
            return;
        
        if (this.task_type === 'cooking') {
            this.initiator = new CookingTaskInitiator(this.data, this.agent);
        } else {
            this.initiator = null;
        }

        await this.teleportBots();

        //wait for a bit so bots are teleported
        await new Promise((resolve) => setTimeout(resolve, 3000));

        if (this.data.initial_inventory) {
            console.log("Setting inventory...");
            let initialInventory = {};
            
            // Handle multi-agent inventory assignment
            if (this.data.agent_count > 1) {
                initialInventory = this.data.initial_inventory[this.agent.count_id.toString()] || {};
                console.log("Initial inventory for agent", this.agent.count_id, ":", initialInventory);
            } else {
                initialInventory = this.data.initial_inventory;
                console.log("Initial inventory:", initialInventory);
            }

            // Assign inventory items
            for (let key of Object.keys(initialInventory)) {
                const itemName = key.toLowerCase();
                const quantity = initialInventory[key];
                await this.agent.bot.chat(`/give ${this.name} ${itemName} ${quantity}`);
                console.log(`Gave ${this.name} ${quantity} ${itemName}`);
            }

            // Wait briefly for inventory commands to complete
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        if (this.initiator) {
            await this.initiator.init();
        }

        if (this.data.agent_count && this.data.agent_count > 1) {
            // TODO wait for other bots to join
            await new Promise((resolve) => setTimeout(resolve, 10000));
            if (this.available_agents.length < this.data.agent_count) {
                console.log(`Missing ${this.data.agent_count - this.available_agents.length} bot(s).`);
                this.agent.killAll();
            }
        }

        if (this.data.goal) {
            await executeCommand(this.agent, `!goal("${this.data.goal}")`);
        }
    
        if (this.data.conversation && this.agent.count_id === 0) {
            let other_name = this.available_agents.filter(n => n !== this.name)[0];
            await executeCommand(this.agent, `!startConversation("${other_name}", "${this.data.conversation}")`);
        }
    }
    
    async teleportBots() {
        console.log('\n\n\n\n\nTeleporting bots');
        function getRandomOffset(range) {
            return Math.floor(Math.random() * (range * 2 + 1)) - range;
        }

        let human_player_name = null;
        let bot = this.agent.bot;
        
        // Finding if there is a human player on the server
        for (const playerName in bot.players) {
            const player = bot.players[playerName];
            if (!this.available_agents.some((n) => n === playerName)) {
                console.log('Found human player:', player.username);
                human_player_name = player.username
                break;
            }
        }

        if (human_player_name) {
            console.log(`Teleporting ${this.name} to human ${human_player_name}`)
            bot.chat(`/tp ${this.name} ${human_player_name}`)
        }
        
        await new Promise((resolve) => setTimeout(resolve, 200));

        if (this.data.type !== 'construction') {
            const pos = getPosition(bot);
            const xOffset = getRandomOffset(5);
            const zOffset = getRandomOffset(5);
            bot.chat(`/tp ${this.name} ${Math.floor(pos.x + xOffset)} ${pos.y + 3} ${Math.floor(pos.z + zOffset)}`);
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
}