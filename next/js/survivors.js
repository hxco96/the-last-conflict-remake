// SURVIVORS: people in the siege community, in the spirit of State of Decay 2.
// Every survivor has a short bio and 2-3 TALENTS. In Siege you play as one of them (the hero):
// personal talents change how you fight and move; community talents work for the whole base while
// their owner is in camp. When your hero dies they are gone for good, and you carry on as another
// member of the community, with their talents. You can take one survivor along as your PARTNER.

export const TALENTS = {
  // personal: only the hero (the survivor you are playing) gets these
  Cardio: { kind: 'personal', desc: 'Moves 6% faster and tires less' },
  PackMule: { kind: 'personal', name: 'Pack Mule', desc: '+1 rucksack slot' },
  Gunslinger: { kind: 'personal', desc: '+20% damage with handguns, magnums and SMGs' },
  Rifleman: { kind: 'personal', desc: '+20% damage with rifles and assault rifles' },
  Brawler: { kind: 'personal', desc: '+25% melee damage' },
  Tough: { kind: 'personal', desc: '+20% max health' },
  NightOwl: { kind: 'personal', name: 'Night Owl', desc: '+15% damage at night' },
  Lucky: { kind: 'personal', desc: '+6% critical chance' },
  Scavenger: { kind: 'personal', desc: 'Supply packs you pick up hold +1' },
  // community: the whole base benefits while the owner is in camp
  Cook: { kind: 'community', desc: 'The camp eats 1 less food every dawn' },
  Gardener: { kind: 'community', desc: 'Each garden grows +1 extra food' },
  Mechanic: { kind: 'community', desc: 'Workshops make +2 extra ammo' },
  Leader: { kind: 'community', desc: '+4 morale every dawn' },
  Medic: { kind: 'community', desc: 'Survivors heal 50% faster in the base' },
  Hoarder: { kind: 'community', desc: 'Stockpile holds +10 of each resource' },
};
export const talentName = (t) => (TALENTS[t] && TALENTS[t].name) || t;

const JOBS = [
  ['line cook', 'Cook'], ['farmhand', 'Gardener'], ['auto mechanic', 'Mechanic'], ['shift manager', 'Leader'],
  ['nurse', 'Medic'], ['paramedic', 'Medic'], ['warehouse worker', 'PackMule'], ['courier', 'Cardio'],
  ['track coach', 'Cardio'], ['police officer', 'Gunslinger'], ['hunter', 'Rifleman'], ['bouncer', 'Brawler'],
  ['roofer', 'Tough'], ['night guard', 'NightOwl'], ['bartender', 'Lucky'], ['pawn shop owner', 'Hoarder'],
  ['garbage collector', 'Scavenger'], ['student', null], ['teacher', 'Leader'], ['plumber', 'Mechanic'],
];
const TOWNS = ['Riverbank', 'the docks', 'Eastgate', 'the old mill town', 'the suburbs', 'downtown', 'Pine Hollow', 'the county line'];
const QUIRKS = [
  'Hums when nervous.', 'Never talks about before.', 'Keeps a photo in their boot.', 'Counts every bullet twice.',
  'Swears they saw the first outbreak.', 'Still wears their work badge.', 'Sleeps with the lights on.', 'Laughs at the worst moments.',
  'Collects lighters.', 'Writes everything down.', 'Lost their family in the first week.', 'Thinks the radio still works.',
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Bio and talents for a survivor record (vet or hero). Their job usually brings one talent.
export function makeBio(v) {
  if (v.talents && v.bio) return v;
  const [job, jobTalent] = pick(JOBS);
  const keys = Object.keys(TALENTS);
  const talents = jobTalent ? [jobTalent] : [];
  const want = Math.random() < 0.35 ? 3 : 2;
  while (talents.length < want) { const t = pick(keys); if (!talents.includes(t)) talents.push(t); }
  v.age = v.age || 19 + Math.floor(Math.random() * 44);
  v.bio = `${v.age}, former ${job} from ${pick(TOWNS)}. ${pick(QUIRKS)}`;
  v.talents = talents;
  return v;
}

export const hasTalent = (v, t) => !!(v && v.talents && v.talents.includes(t));
