import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';

import {
  User,
  Room,
  Message,
  RoomMember
} from '../src/models/index.js';

if (env.isProd) {
  console.error('Refusing to seed in production');
  process.exit(1);
}

const PLACEHOLDER_HASH = 'placeholder-hash-replaced-in-step-4';

const users = [
  {
    username: 'ada',
    email: 'ada@example.dev',
    displayName: 'Ada L.'
  },
  {
    username: 'linus',
    email: 'linus@example.dev',
    displayName: 'Linus T.'
  },
  {
    username: 'grace',
    email: 'grace@example.dev',
    displayName: 'Grace H.'
  }
];

// owner and members are seed instructions, not Room schema fields.
const rooms = [
  {
    slug: 'javascript',
    name: '#javascript',
    description: 'JS, TS, Node, browser APIs',
    tags: ['js', 'ts', 'node'],
    isPrivate: false,
    owner: 'ada',
    members: ['ada', 'linus', 'grace']
  },
  {
    slug: 'python',
    name: '#python',
    description: 'Python, Django, FastAPI, data tooling',
    tags: ['python'],
    isPrivate: false,
    owner: 'grace',
    members: ['ada', 'linus', 'grace']
  },
  {
    slug: 'rust',
    name: '#rust',
    description: 'Ownership, lifetimes, and fearless concurrency',
    tags: ['rust'],
    isPrivate: false,
    owner: 'linus',
    members: ['ada', 'linus', 'grace']
  },
  {
    slug: 'devops',
    name: '#devops',
    description: 'Docker, CI/CD, Kubernetes, observability',
    tags: ['docker', 'k8s'],
    isPrivate: false,
    owner: 'ada',
    members: ['ada', 'linus', 'grace']
  },
  {
    slug: 'databases',
    name: '#databases',
    description: 'SQL, MongoDB, indexing, modeling',
    tags: ['sql', 'mongodb'],
    isPrivate: false,
    owner: 'grace',
    members: ['ada', 'linus', 'grace']
  },
  {
    slug: 'core-team',
    name: '#core-team',
    description: 'Private engineering team discussions',
    tags: ['internal', 'engineering'],
    isPrivate: true,
    owner: 'ada',
    members: ['ada', 'linus']
  }
];

async function main() {
  await connectDB();

  // Wait until all model indexes exist.
  await Promise.all([
    User.init(),
    Room.init(),
    Message.init(),
    RoomMember.init()
  ]);

  // 1. Create or update users.
  await User.bulkWrite(
    users.map((user) => ({
      updateOne: {
        filter: { username: user.username },
        update: {
          $set: user,
          $setOnInsert: {
            passwordHash: PLACEHOLDER_HASH
          }
        },
        upsert: true
      }
    }))
  );

  // Retrieve only our seeded users.
  const savedUsers = await User.find({
    username: {
      $in: users.map((user) => user.username)
    }
  }).lean();

  // Map users by username for predictable lookups.
  const userByUsername = new Map(
    savedUsers.map((user) => [user.username, user])
  );

  // Make sure all expected users exist.
  for (const user of users) {
    if (!userByUsername.has(user.username)) {
      throw new Error(`Seeded user "${user.username}" was not found`);
    }
  }

  // 2. Create or update rooms.
  await Room.bulkWrite(
    rooms.map((room) => {
      const { owner, members, ...roomFields } = room;
      const ownerUser = userByUsername.get(owner);

      return {
        updateOne: {
          filter: { slug: room.slug },
          update: {
            $set: {
              ...roomFields,
              createdBy: ownerUser._id
            }
          },
          upsert: true
        }
      };
    })
  );

  // Retrieve only our seeded rooms.
  const savedRooms = await Room.find({
    slug: {
      $in: rooms.map((room) => room.slug)
    }
  }).lean();

  const roomBySlug = new Map(
    savedRooms.map((room) => [room.slug, room])
  );

  // 3. Create or update room memberships.
  const membershipOperations = rooms.flatMap((room) => {
    const savedRoom = roomBySlug.get(room.slug);

    return room.members.map((username) => {
      const savedUser = userByUsername.get(username);

      return {
        updateOne: {
          filter: {
            room: savedRoom._id,
            user: savedUser._id
          },
          update: {
            $set: {
              role: username === room.owner ? 'owner' : 'member'
            }
          },
          upsert: true
        }
      };
    });
  });

  await RoomMember.bulkWrite(membershipOperations);

  // 4. Retrieve rooms used for message fixtures.
  const js = roomBySlug.get('javascript');
  const py = roomBySlug.get('python');

  // Reset only the message fixtures in these two rooms.
  // DEV ONLY: existing messages in these rooms will be deleted.
  await Message.deleteMany({
    room: {
      $in: [js._id, py._id]
    }
  });

  // 5. Generate sample messages.
  const now = Date.now();

  const texts = [
    'Anyone using top-level await in production?',
    'Event Loop question: why does setImmediate beat setTimeout(0) sometimes?',
    'Remember: microtasks drain before the next macrotask.'
  ];

  const seededUsers = users.map(
    (user) => userByUsername.get(user.username)
  );

  const jsMessages = Array.from({ length: 200 }, (_, i) => {
    const sender = seededUsers[i % seededUsers.length]._id;

    const createdAt = new Date(
      now - (200 - i) * 60_000
    );

    if (i % 10 === 0) {
      return {
        room: js._id,
        sender,
        type: 'code',
        createdAt,
        content: 'Check this out:',
        codeSnippet: {
          language: 'javascript',
          filename: 'demo.js',
          code: 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nawait sleep(100);'
        }
      };
    }

    return {
      room: js._id,
      sender,
      type: 'text',
      createdAt,
      content: `${texts[i % texts.length]} (#${i})`
    };
  });

  const pyMessages = Array.from({ length: 5 }, (_, i) => ({
    room: py._id,
    sender: seededUsers[0]._id,
    type: 'text',
    createdAt: new Date(now - (5 - i) * 60_000),
    content: `Python message ${i}`
  }));

  // 6. Insert messages.
  await Message.insertMany([
    ...jsMessages,
    ...pyMessages
  ]);

  console.log(
    `Seeded ${users.length} users, ${rooms.length} rooms, ${membershipOperations.length} memberships, ${jsMessages.length + pyMessages.length} messages`
  );
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDB();
  });