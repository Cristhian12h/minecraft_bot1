import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { stringifyTurns } from '../utils/text.js';
import { sendRequest } from '../utils/gpt.js';
import { getCommandDocs } from './commands/index.js';


export class History {
    constructor(agent) {
        this.name = agent.name;
        this.save_path = `./bots/${this.name}/save.json`;
        this.turns = [];

        // These define an agent's long term memory
        this.bio = '';
        this.memory = '';

        // Variables for controlling the agent's memory and knowledge
        this.max_messages = 10;
    }

    async getHistory(examples=null) { // expects an Examples object
        let turns = JSON.parse(JSON.stringify(this.turns));
        if (examples) {
            let examples_msg = await examples.createExampleMessage(turns);
            turns = examples_msg.concat(turns);
        }
        
        return turns;
    }

    getSystemMessage() {
        let system_message = `You are a Minecraft bot named ${this.name} that can interact with the world using commands. Act human-like as a typical Minecraft player, not as an AI. Be very brief, dont apologize, do not give instructions unless asked, and do not refuse requests.
        Dont pretend to act, use commands immediately when requested. Do NOT say this: "On my way! Give me a moment.", instead say this: "On my way! !goToPlayer('bingo', 3)".\n`;
        system_message += getCommandDocs();
        if (this.bio != '')
            system_message += '\n\nBio:\n' + this.bio;
        if (this.memory != '')
            system_message += '\n\nMemory:\n' + this.memory;

        return system_message;
    }

    async storeMemories(turns) {
        console.log("To summarize:", turns)
        let memory_prompt = 'Update your "Memory" by summarizing the following conversation. Your "Memory" is for storing information that will help you improve as a Minecraft bot. Include details about your interactions with other players that you may need to remember for later. Also include things that you have learned through player feedback or by executing code. Do not include information found in your Docs or that you got right on the first try. Be extremely brief and clear.';
        if (this.memory != '') {
            memory_prompt += `This is your previous memory: "${this.memory}"\n Include and summarize any relevant information from this previous memory. Your output will replace your previous memory.`;
        }
        memory_prompt += '\n';
        memory_prompt += ' Your output should use one of the following formats:\n';
        memory_prompt += '- When the player... output...\n';
        memory_prompt += '- I learned that player [name]...\n';
        
        memory_prompt += 'This is the conversation to summarize:\n';
        memory_prompt += stringifyTurns(turns);

        memory_prompt += 'Summarize relevant information from your previous memory and this conversation:\n';

        let memory_turns = [{'role': 'system', 'content': memory_prompt}]
        this.memory = await sendRequest(memory_turns, this.getSystemMessage());
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        // Summarize older turns into memory
        if (this.turns.length >= this.max_messages) {
            console.log('summarizing memory')
            let to_summarize = [this.turns.shift()];
            while (this.turns[0].role != 'user' && this.turns.length > 1)
                to_summarize.push(this.turns.shift());
            await this.storeMemories(to_summarize);
        }
    }

    save() {
        // save history object to json file
        mkdirSync(`./bots/${this.name}`, { recursive: true });
        let data = {
            'name': this.name,
            'bio': this.bio,
            'memory': this.memory,
            'turns': this.turns
        };
        const json_data = JSON.stringify(data, null, 4);
        writeFileSync(this.save_path, json_data, (err) => {
            if (err) {
                throw err;
            }
            console.log("JSON data is saved.");
        });
    }

    load(profile) {
        const load_path = profile? `./bots/${this.name}/${profile}.json` : this.save_path;
        try {
            // load history object from json file
            const data = readFileSync(load_path, 'utf8');
            const obj = JSON.parse(data);
            this.bio = obj.bio;
            this.memory = obj.memory;
            this.turns = obj.turns;
        } catch (err) {
            console.error(`No file for profile '${load_path}' for agent ${this.name}.`);
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}