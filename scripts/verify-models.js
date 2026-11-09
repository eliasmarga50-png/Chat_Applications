import { connectDB, disconnectDB } from '../src/config/db.js';
import { User, Room, Message } from '../src/models/index.js';

const planPath = (plan) => {
  const parts = [];
  for (let p = plan; p; p = p.inputStage ?? p.queryPlan) {
    parts.push(p.indexName ? `${p.stage}(${p.indexName})` : p.stage);
  }
  return parts.join(' -> ');
};

async function explain(label, query) {
  const ex = await query.explain('executionStats');
  const s = ex.executionStats;
  console.log(`\n${label}`);
  console.log('  plan          :', planPath(ex.queryPlanner.winningPlan));
  console.log('  docsExamined  :', s.totalDocsExamined);
  console.log('  keysExamined  :', s.totalKeysExamined);
  console.log('  returned      :', s.nReturned);
}

async function main() {
  await connectDB();
  await Promise.all([User.init(), Room.init(), Message.init()]);

  const room = await Room.findOne({ slug: 'javascript' }).lean();
  const user = await User.findOne({ username: 'ada' }).lean();

  console.log('--- 1. Validation: empty message ---');
  try {
    await new Message({ room: room._id, sender: user._id }).validate();
  } catch (e) { console.log('  OK ->', e.errors.content?.message); }

  console.log('--- 2. Validation: type "code" without snippet ---');
  try {
    await new Message({ room: room._id, sender: user._id, type: 'code', content: 'x' }).validate();
  } catch (e) { console.log('  OK ->', e.errors.codeSnippet?.message); }

  console.log('--- 3. Validation: snippet with empty code ---');
  try {
    await new Message({
      room: room._id, sender: user._id, codeSnippet: { language: 'js', code: '' },
    }).validate();
  } catch (e) { console.log('  OK ->', e.errors['codeSnippet.code']?.message); }

  console.log('--- 4. Unique index: duplicate username ---');
  try {
    await User.create({ username: 'ADA', email: 'other@example.dev', passwordHash: 'x' });
  } catch (e) { console.log('  OK -> Mongo error code', e.code, '(11000 = duplicate key)'); }

  console.log('--- 5. passwordHash hidden by default ---');
  const u = await User.findOne({ username: 'ada' });
  console.log('  OK -> passwordHash is', u.passwordHash === undefined ? 'undefined (excluded)' : 'LEAKED');

  console.log('--- 6. Query plans ---');
  await explain(
    'History query WITH index (expect LIMIT -> FETCH -> IXSCAN)',
    Message.find({ room: room._id }).sort({ createdAt: -1 }).limit(20)
  );
  await explain(
    'Same query FORCED to scan (expect COLLSCAN + SORT, far more docs examined)',
    Message.find({ room: room._id }).sort({ createdAt: -1 }).limit(20).hint({ $natural: 1 })
  );

  console.log('\n--- 7. Declared indexes on messages ---');
  const idx = await Message.collection.indexes();
  idx.forEach((i) => console.log('  ', i.name, JSON.stringify(i.key)));
}

main()
  .catch((err) => { console.error('Verify failed:', err); process.exitCode = 1; })
  .finally(disconnectDB);