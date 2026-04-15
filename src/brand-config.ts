import type { BrandId } from './types.js';

export interface BrandConfig {
  brandId: BrandId;
  siteName: string;
  audienceTerm: string;
  audienceTermPlural: string;
  honoreeTerm: string;
  honoreeTermPossessive: string;

  honoreeTypeField: string;
  honoreePersonalityField: string;
  honoreeConsultedField: string;
  honoreePaysShareField: string;
  honoreeHobbiesField: string;
  honoreeFavMusicField: string;
  honoreeFavDrinkField: string;
  honoreeFavFoodField: string;
  blowMindIdeaField: string;

  scoreField: 'bachelorScore' | 'bacheloretteScore';

  activityIntensity: {
    low: string;
    mid: string;
    high: string;
  };

  paysShareValues: {
    honoreeCovered: string;
    splitEvenly: string;
    honoreePays: string;
  };

  honoringMomentValues: readonly string[];

  voiceProfile: 'hypebeast' | 'elevated-editorial';
}

export const BESTMAN_CONFIG: BrandConfig = {
  brandId: 'bestman',
  siteName: 'BESTMAN HQ',
  audienceTerm: 'crew',
  audienceTermPlural: 'crews',
  honoreeTerm: 'groom',
  honoreeTermPossessive: 'his',

  honoreeTypeField: 'groomType',
  honoreePersonalityField: 'groomPersonality',
  honoreeConsultedField: 'groomConsulted',
  honoreePaysShareField: 'groomPaysShare',
  honoreeHobbiesField: 'groomHobbies',
  honoreeFavMusicField: 'groomFavoriteMusic',
  honoreeFavDrinkField: 'groomFavoriteDrink',
  honoreeFavFoodField: 'groomFavoriteFood',
  blowMindIdeaField: 'blowHisMindIdea',

  scoreField: 'bachelorScore',

  activityIntensity: {
    low: 'chill',
    mid: 'moderate',
    high: 'send-it',
  },

  paysShareValues: {
    honoreeCovered: 'covered',
    splitEvenly: 'split',
    honoreePays: 'he-pays',
  },

  honoringMomentValues: ['roast', 'toast_round', 'slideshow', 'low_key', 'skip'],

  voiceProfile: 'hypebeast',
};

export const MOH_CONFIG: BrandConfig = {
  brandId: 'moh',
  siteName: 'Maid of Honor HQ',
  audienceTerm: 'ladies',
  audienceTermPlural: 'ladies',
  honoreeTerm: 'bride',
  honoreeTermPossessive: 'her',

  honoreeTypeField: 'brideType',
  honoreePersonalityField: 'bridePersonality',
  honoreeConsultedField: 'brideConsulted',
  honoreePaysShareField: 'bridePaysShare',
  honoreeHobbiesField: 'brideHobbies',
  honoreeFavMusicField: 'brideFavoriteMusic',
  honoreeFavDrinkField: 'brideFavoriteDrink',
  honoreeFavFoodField: 'brideFavoriteFood',
  blowMindIdeaField: 'blowHerMindIdea',

  scoreField: 'bacheloretteScore',

  activityIntensity: {
    low: 'chill',
    mid: 'balanced',
    high: 'unhinged',
  },

  paysShareValues: {
    honoreeCovered: 'covered',
    splitEvenly: 'split',
    honoreePays: 'she-pays',
  },

  honoringMomentValues: ['toast_round', 'slideshow', 'speech_circle', 'low_key', 'skip'],

  voiceProfile: 'elevated-editorial',
};

export function configForBrand(brandId: BrandId): BrandConfig {
  return brandId === 'bestman' ? BESTMAN_CONFIG : MOH_CONFIG;
}
