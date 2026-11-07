/**
 * The lake house: stations (each gets a printed QR code) and the chores dealt from them.
 * Bedrooms and bathrooms are out of bounds, so no station is in one.
 *
 * Chore kinds:
 *   task   scan the station, then a ~2-minute game on the phone
 *          (puzzle: hold | wordle | make24 | snake | blackjack | tap50 | crack; the old order | simon | match still load)
 *   photo  scan the station, then take a photo there; with `partner`, another living player has to be in it and confirm
 *   carry  scan `from` to pick up `item`, then scan `to` to drop it off
 *   act    scan the station, then do something for real (sing, dance, play) for at least `seconds`; `max` caps how many
 *          players get it per game, since there's one radio, one table, one sim
 *   talk   anywhere: ask `need` different players a question; each one confirms on their phone
 */

/**
 * `map` places a station on a floor plan in lake/public/maps/<floor>.jpg, in % of the image (none for outside and games).
 * `retired` stations are never used (the main-floor office is a bedroom); they stay listed so saved games still load.
 */
export const STATIONS = [
  { id: 'campfire', floor: 'Main', name: 'Campfire', where: 'Great Room, by the big fireplace (main floor, west side)', map: { floor: 'main', x: 16.6, y: 22.5 } },
  { id: 'sunroom', floor: 'Main', name: 'Sunroom', where: 'Main floor, lake side, off the breakfast nook', map: { floor: 'main', x: 41.9, y: 15.7 } },
  { id: 'kitchen', floor: 'Main', name: 'Kitchen', where: 'Main floor, the island', map: { floor: 'main', x: 62.2, y: 37.3 } },
  { id: 'dining', floor: 'Main', name: 'Dining Room', where: 'Main floor, east side', map: { floor: 'main', x: 85.4, y: 39.2 } },
  { id: 'east-living', floor: 'Main', name: 'East Living Room', where: 'Main floor, east side, by the second fireplace', map: { floor: 'main', x: 85.4, y: 66.7 } },
  { id: 'foyer', floor: 'Main', name: 'Foyer', where: 'Main floor, inside the front door', map: { floor: 'main', x: 63.0, y: 74.5 } },
  { id: 'office', floor: 'Main', name: 'Office', where: 'Main floor, next to the foyer', map: { floor: 'main', x: 42.3, y: 68.6 }, retired: true },
  { id: 'laundry', floor: 'Main', name: 'Laundry Room', where: 'Main floor, by the garage', map: { floor: 'main', x: 25.3, y: 41.2 } },
  { id: 'up-west', floor: 'Upstairs', name: 'Upstairs Landing', where: 'Upstairs, top of the Great Room stairs', map: { floor: 'upstairs', x: 24.0, y: 35.3 } },
  { id: 'up-east', floor: 'Upstairs', name: 'Upstairs Hall', where: 'Upstairs, the hallway outside the primary bedroom', map: { floor: 'upstairs', x: 70.5, y: 48.5 } },
  { id: 'den', floor: 'Basement', name: 'Basement Living Room', where: 'Basement, the big room facing the lake', map: { floor: 'basement', x: 73.8, y: 40.9 } },
  { id: 'media', floor: 'Basement', name: 'Media Room', where: 'Basement, by the fireplace', map: { floor: 'basement', x: 85.4, y: 73.9 } },
  { id: 'gym', floor: 'Basement', name: 'Gym', where: 'Basement, back corner', map: { floor: 'basement', x: 57.2, y: 84.1 } },
  { id: 'bar', floor: 'Basement', name: 'Basement Kitchen', where: 'Basement, next to the gym', map: { floor: 'basement', x: 70.5, y: 83.0 } },
  { id: 'b-office', floor: 'Basement', name: 'Basement Office', where: 'Basement, lake side, by the garage', map: { floor: 'basement', x: 41.0, y: 38.6 } },
  { id: 'screened-patio', floor: 'Basement', name: 'Screened Patio', where: 'Outside the basement living room, lake side', map: { floor: 'basement', x: 74.2, y: 17.0 } },
  { id: 'covered-patio', floor: 'Basement', name: 'Covered Patio', where: 'Outside the basement office, lake side', map: { floor: 'basement', x: 42.7, y: 17.0 } },
  { id: 'dock', floor: 'Outside', name: 'Dock', where: 'Down at the water' },
  { id: 'shore', floor: 'Outside', name: 'Lakeshore', where: 'The lawn by the water' },
  { id: 'radio', floor: 'Games', name: 'Radio', where: 'By the house radio' },
  { id: 'pingpong', floor: 'Basement', name: 'Ping Pong Table', where: 'Basement, at the ping pong table', map: { floor: 'basement', x: 62.0, y: 31.0 } },
  { id: 'curling', floor: 'Basement', name: 'Table Curling', where: 'Basement, at the table curling (桌上冰壶) board', map: { floor: 'basement', x: 88.0, y: 31.0 } },
  { id: 'golf', floor: 'Basement', name: 'Golf Sim', where: 'Basement, at the golf simulator', map: { floor: 'basement', x: 64.0, y: 52.0 } },
];

export const CHORES = [
  // ~2-minute phone games dealt into any room (the game sets the room); one of these goes in every room
  { id: 'pg-hold', kind: 'task', title: 'Hold the line', detail: 'Hold the button for 2 minutes. Let go for more than a second and you lose.', puzzle: 'hold' },
  { id: 'pg-wordle', kind: 'task', title: 'Wordle', detail: 'Guess the 5-letter word in 6 tries.', puzzle: 'wordle' },
  { id: 'pg-24', kind: 'task', title: 'Make 24', detail: 'Make 24 from four cards with + − × ÷. Solve 3 hands.', puzzle: 'make24' },
  { id: 'pg-snake', kind: 'task', title: 'Snake', detail: 'Eat 12 apples without crashing.', puzzle: 'snake' },
  { id: 'pg-bj', kind: 'task', title: 'Blackjack', detail: 'Win 3 hands before the dealer beats you 3 times.', puzzle: 'blackjack' },
  { id: 'pg-50', kind: 'task', title: 'Tap 1 to 50', detail: 'Tap the numbers 1 to 50 in order. A wrong tap freezes you for 3 seconds.', puzzle: 'tap50' },
  { id: 'pg-crack', kind: 'task', title: 'Crack the code', detail: 'Brute-force the 2-digit code, one try at a time.', puzzle: 'crack' },

  // the same games pinned to rooms: from the earlier per-player deal, kept so saved games still load

  { id: 'g-hold-hall', kind: 'task', station: 'up-east', title: 'Hold the line', detail: 'Hold the button for 2 minutes. Let go for more than a second and you lose.', puzzle: 'hold' },
  { id: 'g-hold-patio', kind: 'task', station: 'screened-patio', title: 'Hold the line', detail: 'Hold the button for 2 minutes. Let go for more than a second and you lose.', puzzle: 'hold' },
  { id: 'g-wordle-up', kind: 'task', station: 'up-west', title: 'Wordle', detail: 'Guess the 5-letter word in 6 tries.', puzzle: 'wordle' },
  { id: 'g-wordle-office', kind: 'task', station: 'b-office', title: 'Wordle', detail: 'Guess the 5-letter word in 6 tries.', puzzle: 'wordle' },
  { id: 'g-24-dining', kind: 'task', station: 'dining', title: 'Make 24', detail: 'Make 24 from four cards with + − × ÷. Solve 3 hands.', puzzle: 'make24' },
  { id: 'g-24-bar', kind: 'task', station: 'bar', title: 'Make 24', detail: 'Make 24 from four cards with + − × ÷. Solve 3 hands.', puzzle: 'make24' },
  { id: 'g-snake-media', kind: 'task', station: 'media', title: 'Snake', detail: 'Eat 12 apples without crashing.', puzzle: 'snake' },
  { id: 'g-snake-sun', kind: 'task', station: 'sunroom', title: 'Snake', detail: 'Eat 12 apples without crashing.', puzzle: 'snake' },
  { id: 'g-bj-den', kind: 'task', station: 'den', title: 'Blackjack', detail: 'Win 3 hands before the dealer beats you 3 times.', puzzle: 'blackjack' },
  { id: 'g-bj-east', kind: 'task', station: 'east-living', title: 'Blackjack', detail: 'Win 3 hands before the dealer beats you 3 times.', puzzle: 'blackjack' },
  { id: 'g-50-kitchen', kind: 'task', station: 'kitchen', title: 'Tap 1 to 50', detail: 'Tap the numbers 1 to 50 in order. A wrong tap freezes you for 3 seconds.', puzzle: 'tap50' },
  { id: 'g-50-laundry', kind: 'task', station: 'laundry', title: 'Tap 1 to 50', detail: 'Tap the numbers 1 to 50 in order. A wrong tap freezes you for 3 seconds.', puzzle: 'tap50' },
  { id: 'g-crack-office', kind: 'task', station: 'office', title: 'Crack the Wi-Fi password', detail: 'Brute-force the 2-digit code, one try at a time.', puzzle: 'crack' },
  { id: 'g-crack-foyer', kind: 'task', station: 'foyer', title: 'Crack the lockbox', detail: 'Brute-force the 2-digit code, one try at a time.', puzzle: 'crack' },

  // real-world activities at each station, done while the phone's timer runs (honor system: do the whole thing)
  { id: 'plants', kind: 'act', station: 'sunroom', title: 'Tree pose', detail: 'Hold a yoga tree pose (one foot up, hands together) until the timer runs out. Wobbling is fine, falling over is not.', seconds: 30, max: 2 },
  { id: 'spices', kind: 'act', station: 'kitchen', title: 'Wash 3 cups', detail: 'Wash and dry 3 cups or dishes and put them away. The house thanks you.', seconds: 45, max: 2 },
  { id: 'table', kind: 'act', station: 'dining', title: 'Cup pyramid', detail: 'Stack 6 cups into a 3-2-1 pyramid on the dining table, then put them back.', seconds: 30, max: 2 },
  { id: 'radio', kind: 'act', station: 'east-living', title: 'Do an impression', detail: 'Do your best impression of someone in the club, out loud, for the whole timer.', seconds: 20, voice: true, max: 2 },
  { id: 'lock', kind: 'act', station: 'foyer', title: '20 jumping jacks', detail: 'Do 20 jumping jacks in the foyer.', seconds: 20, max: 2 },
  { id: 'router', kind: 'act', station: 'b-office', title: 'Leave a compliment', detail: 'Write a compliment for another player on paper (signed or anonymous) and leave it on the office desk.', seconds: 30, max: 2 },
  { id: 'fold', kind: 'act', station: 'laundry', title: 'Fold 3 towels', detail: 'Neatly fold 3 towels or shirts.', seconds: 30, max: 2 },
  { id: 'frames', kind: 'act', station: 'up-west', title: '15 squats', detail: 'Do 15 squats on the landing.', seconds: 20, max: 2 },
  { id: 'bulb', kind: 'act', station: 'up-east', title: 'Plank', detail: 'Hold a plank until the timer runs out.', seconds: 30, max: 2 },
  { id: 'games', kind: 'act', station: 'den', title: 'Rock, paper, scissors', detail: 'Beat another player at rock, paper, scissors, best of 3. Lose? Find someone else and go again.', seconds: 15, max: 2 },
  { id: 'movie', kind: 'act', station: 'media', title: 'Movie scene', detail: 'Act out a famous movie scene, out loud, for the whole timer. Bonus points for an audience.', seconds: 20, voice: true, max: 2 },
  { id: 'weights', kind: 'act', station: 'gym', title: '10 push-ups', detail: 'Do 10 push-ups (knees are fine).', seconds: 20, max: 2 },
  { id: 'fridge', kind: 'act', station: 'bar', title: 'Serve a drink', detail: 'Pour a glass of water (or a drink) and hand it to another player.', seconds: 20, max: 2 },
  { id: 'receipts', kind: 'act', station: 'b-office', title: 'Quick portrait', detail: 'Draw a portrait of another player on paper before the timer runs out, and give it to them.', seconds: 60, max: 2 },
  { id: 'sweep', kind: 'act', station: 'screened-patio', title: 'Wall sit', detail: 'Hold a wall sit until the timer runs out.', seconds: 30, max: 2 },
  { id: 'wipe', kind: 'act', station: 'covered-patio', title: 'Flamingo', detail: 'Stand on one foot with your eyes closed until the timer runs out. Start over if you touch down.', seconds: 15, max: 2 },
  { id: 'lines', kind: 'act', station: 'dock', title: 'Count the boats', detail: 'Count the boats you can see on the lake, then tell the next player you meet how many.', seconds: 20, max: 2 },
  { id: 'ducks', kind: 'act', station: 'shore', title: 'Skip a stone', detail: 'Skip a stone on the lake from the shore. Keep trying until one skips.', seconds: 20, max: 2 },

  { id: 'dock-selfie', kind: 'photo', station: 'dock', title: 'Dock selfie', prompt: 'A selfie with another player on the dock', partner: true },
  { id: 'lake-shot', kind: 'photo', station: 'shore', title: 'Lake shot', prompt: 'Your best photo of the lake', partner: false },
  { id: 'sunroom-view', kind: 'photo', station: 'sunroom', title: 'Sunroom view', prompt: 'The view from the sunroom', partner: false },
  { id: 'patio-selfie', kind: 'photo', station: 'screened-patio', title: 'Patio selfie', prompt: 'A selfie with another player on the screened patio', partner: true },
  { id: 'portrait', kind: 'photo', station: 'east-living', title: 'Family portrait', prompt: 'A posed "family portrait" with another player by the fireplace', partner: true },
  { id: 'snack', kind: 'photo', station: 'kitchen', title: 'Snack report', prompt: 'The best snack in the kitchen', partner: false },
  { id: 'poster', kind: 'photo', station: 'media', title: 'Movie poster', prompt: 'A movie-poster pose with another player in the media room', partner: true },

  { id: 'ice', kind: 'carry', from: 'bar', to: 'kitchen', title: 'Bring up the ice', item: 'the ice' },
  { id: 'towels', kind: 'carry', from: 'laundry', to: 'up-east', title: 'Deliver fresh towels', item: 'the towels' },
  { id: 'jacket', kind: 'carry', from: 'screened-patio', to: 'dock', title: 'Return the life jacket', item: 'the life jacket' },
  { id: 'firewood', kind: 'carry', from: 'covered-patio', to: 'east-living', title: 'Bring in firewood', item: 'the firewood' },
  { id: 'boardgame', kind: 'carry', from: 'den', to: 'up-west', title: 'Return the board game', item: 'the board game' },
  { id: 'mail', kind: 'carry', from: 'foyer', to: 'b-office', title: 'Drop off the mail', item: 'the mail' },

  { id: 'baby', kind: 'act', station: 'radio', title: 'Sing "Baby" on the radio', detail: 'Sing the chorus of Justin Bieber\'s "Baby" over the radio so the whole house hears it.', seconds: 30, voice: true, max: 2 },
  { id: 'shoutout', kind: 'act', station: 'radio', title: 'Radio shout-out', detail: 'Give a shout-out over the radio to someone in the club. Make it heartfelt.', seconds: 20, voice: true, max: 2 },
  { id: 'dance', kind: 'act', station: 'campfire', title: 'Dance by the fire', detail: 'Dance at the Campfire until the timer runs out. No stopping!', seconds: 45, max: 3 },
  { id: 'pingpong', kind: 'act', station: 'pingpong', title: 'Table tennis with Buju', detail: 'Win a point against Buju. If Buju is busy, anyone at the table will do.', seconds: 20, max: 2 },
  { id: 'curling', kind: 'act', station: 'curling', title: 'Table curling: two threes', detail: 'Keep sliding until two of your stones finish in the 3 zone.', seconds: 20, max: 2 },
  { id: 'golf', kind: 'act', station: 'golf', title: 'Golf sim: 4 or under', detail: 'Play a hole on the golf sim and finish it in 4 hits or fewer. Keep trying until you do.', seconds: 45, max: 2 },
  { id: 'talk', kind: 'talk', title: 'Catch up with 3 people', detail: 'Ask 3 different players the question on your phone. Each one confirms on their phone.', need: 3, max: 4 },
];

/** Questions for the talk chore, one picked at random per conversation. */
export const QUESTIONS = [
  "What's the best trade you've ever made (any kind)?",
  "What's your go-to karaoke song?",
  "If you could live anywhere for a year, where?",
  "What's a hot take you'll defend forever?",
  "What's the best meal you've ever had?",
  "Who in the club would survive longest in a horror movie?",
  "What would you do with a million dollars tomorrow?",
  "What's your most-played song this month?",
  "What's one thing on your bucket list?",
  "What's the funniest thing that happened to you this semester?",
];

/** Where meetings happen; scanning its code is how a player rings the bell. */
export const CAMPFIRE = 'campfire';

/** The two stations a storm asks players to secure, far apart on purpose (top floor and lake side of the basement). */
export const STORM_DEFAULT = ['up-east', 'screened-patio'];
