import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { User, Room, Message } from '../src/models/index.js';

if (env.isProd) {
  console.error('Refusing to seed in production');
  process.exit(1);
}

const PLACEHOLDER_HASH = 'placeholder-hash-replaced-in-step-4';

const users = [
  { username: 'ada', email: 'ada@example.dev', displayName: 'Ada L.' },
  { username: 'linus', email: 'linus@example.dev', displayName: 'Linus T.' },
  { username: 'grace', email: 'grace@example.dev', displayName: 'Grace H.' },
];

const rooms = [
  { slug: 'javascript', name: '#javascript', description: 'JS, TS, Node, browser APIs', tags: ['js', 'ts', 'node'] },
  { slug: 'python', name: '#python', description: 'Python, Django, FastAPI, data tooling', tags: ['python'] },
  { slug: 'rust', name: '#rust', description: 'Ownership, lifetimes, and fearless concurrency', tags: ['rust'] },
  { slug: 'devops', name: '#devops', description: 'Docker, CI/CD, Kubernetes, observability', tags: ['docker', 'k8s'] },
  { slug: 'databases', name: '#databases', description: 'SQL, MongoDB, indexing, modeling', tags: ['sql', 'mongodb'] },
];

async function main() {
  await connectDB();

  // Wait until every declared index actually exists on the server.
  await Promise.all([User.init(), Room.init(), Message.init()]);

  // Idempotent upserts: safe to run repeatedly.
  await User.bulkWrite(
    users.map((u) => ({
      updateOne: {
        filter: { username: u.username },
        update: { $set: u, $setOnInsert: { passwordHash: PLACEHOLDER_HASH } },
        upsert: true,
      },
    }))
  );
  await Room.bulkWrite(
    rooms.map((r) => ({
      updateOne: { filter: { slug: r.slug }, update: { $set: r }, upsert: true },
    }))
  );

  const savedUsers = await User.find().lean();
  const js = await Room.findOne({ slug: 'javascript' }).lean();
  const py = await Room.findOne({ slug: 'python' }).lean();

  await Message.deleteMany({}); // DEV ONLY

  const now = Date.now();
  const texts = [
    'Anyone using top-level await in production?',
    'Event Loop question: why does setImmediate beat setTimeout(0) sometimes?',
    'Remember: microtasks drain before the next macrotask.',
  ];

  // 200 messages in #javascript, one per minute, so index vs. scan is visible.
  const jsMessages = Array.from({ length: 200 }, (_, i) => {
    const sender = savedUsers[i % savedUsers.length]._id;
    const createdAt = new Date(now - (200 - i) * 60_000);
    if (i % 10 === 0) {
      return {
        room: js._id, sender, type: 'code', createdAt,
        content: 'Check this out:',
        codeSnippet: {
          language: 'javascript',
          filename: 'demo.js',
          code: 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nawait sleep(100);',
        },
      };
    }
    return { room: js._id, sender, type: 'text', createdAt, content: `${texts[i % texts.length]} (#${i})` };
  });

  const pyMessages = Array.from({ length: 5 }, (_, i) => ({
    room: py._id,
    sender: savedUsers[0]._id,
    content: `Python message ${i}`,
    createdAt: new Date(now - (5 - i) * 60_000),
  }));

  await Message.insertMany([...jsMessages, ...pyMessages]);
  console.log(`Seeded ${users.length} users, ${rooms.length} rooms, ${jsMessages.length + pyMessages.length} messages`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(disconnectDB);