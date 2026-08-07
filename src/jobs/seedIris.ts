/**
 * Seeds the iris-colour reference collection used by the styling feature (EB-06).
 * Idempotent — upserts by `category`. Run with: `npm run seed:iris`.
 *
 * All styling suggestions are cosmetic/informational only — no health claims.
 */
import { connectDB, disconnectDB } from '../config/db';
import { IrisColor } from '../models/IrisColor';
import { logger } from '../utils/logger';

interface SeedIris {
  category: string;
  name: string;
  hex: string;
  description: string;
  styling: { makeup: string[]; lensIdeas: string[]; clothing: string[] };
}

const IRIS_SEED: SeedIris[] = [
  {
    category: 'deep_brown',
    name: 'Deep Brown',
    hex: '#3B2416',
    description:
      'Like rich espresso poured in warm light, your eyes carry a deep, cosy glow.',
    styling: {
      makeup: ['Bronze & copper shadows', 'Warm gold liner', 'Terracotta tones'],
      lensIdeas: ['Honey', 'Warm hazel'],
      clothing: ['Emerald green', 'Cream', 'Warm reds'],
    },
  },
  {
    category: 'warm_hazel',
    name: 'Warm Hazel',
    hex: '#8E6B3A',
    description:
      'Like autumn leaves caught in morning sunlight, your eyes hold depths of amber and gold.',
    styling: {
      makeup: ['Plum & mauve shadows', 'Soft green liner to lift the green', 'Champagne shimmer'],
      lensIdeas: ['Amber', 'Light hazel'],
      clothing: ['Olive', 'Burgundy', 'Soft gold'],
    },
  },
  {
    category: 'amber',
    name: 'Amber',
    hex: '#B06A2C',
    description:
      'Golden and coppery, your eyes catch the light like honey in a jar.',
    styling: {
      makeup: ['Deep browns', 'Forest-green accents', 'Bronze highlight'],
      lensIdeas: ['Honey', 'Green'],
      clothing: ['Teal', 'Chocolate brown', 'Mustard'],
    },
  },
  {
    category: 'green',
    name: 'Green',
    hex: '#3E7A54',
    description:
      'Fresh and vivid, your eyes shimmer like sunlight through spring leaves.',
    styling: {
      makeup: ['Reddish-brown & plum shadows (complementary)', 'Copper liner', 'Peach blush'],
      lensIdeas: ['Emerald', 'Grey-green'],
      clothing: ['Plum', 'Rust', 'Warm neutrals'],
    },
  },
  {
    category: 'ocean_blue',
    name: 'Ocean Blue',
    hex: '#3A6EA5',
    description:
      'Clear and cool, your eyes hold the calm depth of open ocean water.',
    styling: {
      makeup: ['Warm coppers & bronzes (complementary)', 'Navy liner for depth', 'Peach tones'],
      lensIdeas: ['Sapphire', 'Grey-blue'],
      clothing: ['Warm orange', 'Camel', 'Denim blue'],
    },
  },
  {
    category: 'grey',
    name: 'Grey',
    hex: '#7C8A96',
    description:
      'Soft and silvery, your eyes shift like storm clouds catching the light.',
    styling: {
      makeup: ['Cool silvers & taupes', 'Charcoal smoke', 'Rose accents'],
      lensIdeas: ['Steel grey', 'Cool blue'],
      clothing: ['Charcoal', 'Blush pink', 'Icy blue'],
    },
  },
];

async function seedIris(): Promise<void> {
  await connectDB();
  try {
    for (const iris of IRIS_SEED) {
      await IrisColor.updateOne(
        { category: iris.category },
        { $set: iris },
        { upsert: true },
      );
    }
    const count = await IrisColor.countDocuments();
    logger.info(`Iris seed complete — ${IRIS_SEED.length} upserted, ${count} total`);
  } finally {
    await disconnectDB();
  }
}

seedIris().catch((err) => {
  logger.error('Iris seed failed', err);
  process.exit(1);
});
