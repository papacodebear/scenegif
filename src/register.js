import 'dotenv/config';
import { config } from './config.js';

const COMMANDS = [
  {
    name: 'scene',
    description: 'Find a scene and turn it into a GIF',
    type: 1,
    options: [
      { type: 3, name: 'scene', description: "Describe the scene (e.g. 'Hercules Fates cutting the thread')", required: true },
      { type: 3, name: 'caption', description: 'Optional caption to overlay on the GIF', required: false },
    ],
  },
  {
    name: 'clip',
    description: 'Make a GIF from a YouTube link and exact timestamps',
    type: 1,
    options: [
      { type: 3, name: 'url', description: 'YouTube link (a ?t= in the link is used as the start)', required: true },
      { type: 3, name: 'start', description: 'Start time, e.g. 1:23 or 83.5', required: false },
      { type: 3, name: 'end', description: 'End time, at most 4s after start', required: false },
      { type: 3, name: 'caption', description: 'Optional caption to overlay on the GIF', required: false },
    ],
  },
];

const url = `${config.discordApiBase}/applications/${config.discordAppId}/commands`;
const headers = { Authorization: `Bot ${config.discordToken}`, 'Content-Type': 'application/json' };

for (const command of COMMANDS) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(command) });
  if (!res.ok) throw new Error(`Failed to register /${command.name}: ${await res.text()}`);
  console.log(`Registered: /${command.name}`);
}
