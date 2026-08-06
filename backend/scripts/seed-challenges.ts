import 'dotenv/config'
import { prisma } from '../src/db/client'
import { CHALLENGES_DIR, seedChallengesFromDirectory } from '../src/challenges/service'

seedChallengesFromDirectory(prisma, CHALLENGES_DIR)
  .then(async () => {
    console.log('Challenges seeded.')
    await prisma.$disconnect()
  })
  .catch(async (err) => {
    console.error('Failed to seed challenges:', err)
    await prisma.$disconnect()
    process.exit(1)
  })
