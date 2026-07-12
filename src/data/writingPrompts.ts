import type { Language } from '../i18n'
import type { SeasonKey } from '../utils/date'

export const writingPrompts: Record<Language, string[]> = {
  en: [
    'What made you smile today, even briefly?',
    "What's something you're looking forward to?",
    'Describe the weather today and how it made you feel.',
    "What's a small thing that went right today?",
    'Who did you talk to today, and what do you remember about it?',
    "What's something you're grateful for right now?",
    'What did you eat today that you enjoyed?',
    'What decision did you make today, big or small?',
    'If today had a title, what would it be?',
    'What did you learn today?',
    "What's something you're avoiding thinking about?",
    'Describe a sound you heard today.',
    "What's on your mind right now, unfiltered?",
    'What would you tell yourself from a year ago?',
    "What's a place you'd like to be right now?",
    'What surprised you today?',
    "What's something you're proud of this week?",
    'How did you take care of yourself today?',
    "What's a conversation that stuck with you recently?",
    "What's something ordinary you don't want to forget?",
    "What's worrying you, and what's one small step about it?",
    'What made today different from yesterday?',
    "What's a song, show, or book on your mind lately?",
    'If you could relive one moment from today, which would it be?',
  ],
  ja: [
    '今日、少しでも笑えた瞬間は？',
    'これから楽しみにしていることは？',
    '今日の天気は？それでどんな気分になった？',
    '今日、うまくいった小さなことは？',
    '今日話した人と、印象に残っていることは？',
    '今、感謝していることは？',
    '今日食べたもので美味しかったものは？',
    '今日、大小問わず決めたことは？',
    '今日にタイトルをつけるなら？',
    '今日学んだことは？',
    '考えないようにしていることは？',
    '今日聞いた音で印象に残っているものは？',
    '今、頭に浮かんでいることをそのまま書いてみると？',
    '1年前の自分に伝えたいことは？',
    '今いたい場所はどこ？',
    '今日、驚いたことは？',
    '今週、自分を褒めたいことは？',
    '今日、自分をどう労った？',
    '最近印象に残っている会話は？',
    '忘れたくない、なんでもない日常の一コマは？',
    '気がかりなことと、そのための小さな一歩は？',
    '今日が昨日と違ったところは？',
    '最近気になっている曲・映画・本は？',
    '今日をもう一度過ごせるなら、どの瞬間を選ぶ？',
  ],
}

// Shown once an entry already has content, to nudge elaboration rather than
// a fresh start — phrased around what's missing or unsaid, not "what happened".
export const appendPrompts: Record<Language, string[]> = {
  en: [
    "Is there a detail you left out that's worth adding?",
    "What's still on your mind that you haven't written down yet?",
    'Who else was part of today that you haven\'t mentioned?',
    'What happened right before or after what you just wrote?',
    "Is there a feeling underneath this that's worth naming?",
    "What's a detail you'd want to remember if you read this in five years?",
    'Anything you glossed over that deserves another sentence?',
    "What's the part of today you haven't gotten to yet?",
  ],
  ja: [
    '書き忘れていて、残しておきたいことはある？',
    'まだ言葉にできていないけど、気になっていることは？',
    'まだ登場していない人で、今日関わった人は？',
    'さっき書いたことの前後で、何かあった？',
    '書いた内容の裏にある気持ちを、言葉にするなら？',
    '5年後にこれを読み返すとしたら、他に何を書いておきたい？',
    'さらっと流したけど、もう一言足したいことは？',
    'まだ書けていない、今日のもう一つの場面は？',
  ],
}

export interface DynamicPromptTemplates {
  milestoneUpcoming: (label: string, days: number) => string
  milestoneToday: (label: string) => string
  milestoneRecent: (label: string, days: number) => string
  gapShort: (days: number) => string
  gapMedium: (days: number) => string
  gapLong: (days: number) => string
  streak: (days: number) => string
  weekdayMonday: () => string
  weekdayFriday: () => string
  weekend: () => string
  season: (season: SeasonKey) => string
  holiday: (name: string) => string
  recurringTopic: (term: string) => string
  mentionedTopic: (term: string) => string
}

// Templated prompts filled from cheap per-user signals (milestones, entry
// cadence, calendar) rather than a fixed list, so the "need an idea?" nudge
// stays personalized without depending on any content in the (empty) entry
// itself. See src/utils/dynamicPrompts.ts for how these are selected.
export const dynamicPromptTemplates: Record<Language, DynamicPromptTemplates> = {
  en: {
    milestoneUpcoming: (label, days) => `${label} is in ${days} day${days === 1 ? '' : 's'} — what's on your mind about it?`,
    milestoneToday: label => `Today is ${label} — how does it feel?`,
    milestoneRecent: (label, days) => `It's been ${days} day${days === 1 ? '' : 's'} since ${label} — how are you settling back in?`,
    gapShort: days => `It's been ${days} days since your last entry — what happened in between?`,
    gapMedium: days => `${days} days since you last wrote — what stands out looking back?`,
    gapLong: days => `It's been ${days} days since your last entry — where are you at right now?`,
    streak: days => `${days} days in a row now — what's on your mind today?`,
    weekdayMonday: () => 'Monday again — what are you hoping for this week?',
    weekdayFriday: () => 'Friday — how would you sum up this week?',
    weekend: () => 'Weekend mode — how are you spending today?',
    season: season => ({
      spring: 'Anything about this spring on your mind?',
      summer: 'Anything from the summer heat worth writing down?',
      autumn: "What's caught your eye this autumn?",
      winter: "How's the winter cold treating you?",
    })[season],
    holiday: name => `Today is ${name} — how are you spending it?`,
    recurringTopic: term => `You used to write about "${term}" a lot — what's the latest there?`,
    mentionedTopic: term => `You mentioned "${term}" — is there more to say about it?`,
  },
  ja: {
    milestoneUpcoming: (label, days) => `「${label}」まであと${days}日。今どんな気持ち？`,
    milestoneToday: label => `今日は「${label}」ですね。どんな一日でしたか？`,
    milestoneRecent: (label, days) => `「${label}」から${days}日経ちました。その後はどうですか？`,
    gapShort: days => `前回の記録から${days}日経ちました。その間に何がありましたか？`,
    gapMedium: days => `${days}日ぶりの記録ですね。振り返ってみると、印象に残っていることは？`,
    gapLong: days => `${days}日ぶりの記録です。今、どんな気分ですか？`,
    streak: days => `${days}日連続で書けていますね。今日はどんなことがありましたか？`,
    weekdayMonday: () => 'また月曜日ですね。今週楽しみにしていることは？',
    weekdayFriday: () => '週末目前ですね。今週を一言でまとめると？',
    weekend: () => '週末はどう過ごしていますか？',
    season: season => ({
      spring: '春らしさを感じたことは？',
      summer: 'この夏、印象に残っていることは？',
      autumn: '秋らしいと感じた瞬間は？',
      winter: '冬の寒さの中で感じたことは？',
    })[season],
    holiday: name => `今日は${name}ですね。どう過ごしましたか？`,
    recurringTopic: term => `以前「${term}」についてよく書いていましたね。最近はどうですか？`,
    mentionedTopic: term => `「${term}」について書いていましたね。もう少し詳しく書いてみる？`,
  },
}
