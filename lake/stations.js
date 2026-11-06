/**
 * The lake house: stations (each gets a printed QR code) and the chores dealt from them.
 * Bedrooms and bathrooms are out of bounds, so no station is in one.
 *
 * Chore kinds:
 *   task   scan the station, then a short puzzle on the phone (puzzle: hold | order | simon | match)
 *   photo  scan the station, then take a photo there; with `partner`, another living player has to be in it and confirm
 *   carry  scan `from` to pick up `item`, then scan `to` to drop it off
 */

export const STATIONS = [
  { id: 'campfire', floor: 'Main', name: 'Campfire', where: 'Great Room, by the big fireplace (main floor, west side)' },
  { id: 'sunroom', floor: 'Main', name: 'Sunroom', where: 'Main floor, lake side, off the breakfast nook' },
  { id: 'kitchen', floor: 'Main', name: 'Kitchen', where: 'Main floor, the island' },
  { id: 'dining', floor: 'Main', name: 'Dining Room', where: 'Main floor, east side' },
  { id: 'east-living', floor: 'Main', name: 'East Living Room', where: 'Main floor, east side, by the second fireplace' },
  { id: 'foyer', floor: 'Main', name: 'Foyer', where: 'Main floor, inside the front door' },
  { id: 'office', floor: 'Main', name: 'Office', where: 'Main floor, next to the foyer' },
  { id: 'laundry', floor: 'Main', name: 'Laundry Room', where: 'Main floor, by the garage' },
  { id: 'up-west', floor: 'Upstairs', name: 'Upstairs Landing', where: 'Upstairs, top of the Great Room stairs' },
  { id: 'up-east', floor: 'Upstairs', name: 'Upstairs Hall', where: 'Upstairs, the hallway outside the primary bedroom' },
  { id: 'den', floor: 'Basement', name: 'Basement Living Room', where: 'Basement, the big room facing the lake' },
  { id: 'media', floor: 'Basement', name: 'Media Room', where: 'Basement, by the fireplace' },
  { id: 'gym', floor: 'Basement', name: 'Gym', where: 'Basement, back corner' },
  { id: 'bar', floor: 'Basement', name: 'Basement Kitchen', where: 'Basement, next to the gym' },
  { id: 'b-office', floor: 'Basement', name: 'Basement Office', where: 'Basement, lake side, by the garage' },
  { id: 'screened-patio', floor: 'Basement', name: 'Screened Patio', where: 'Outside the basement living room, lake side' },
  { id: 'covered-patio', floor: 'Basement', name: 'Covered Patio', where: 'Outside the basement office, lake side' },
  { id: 'dock', floor: 'Outside', name: 'Dock', where: 'Down at the water' },
  { id: 'shore', floor: 'Outside', name: 'Lakeshore', where: 'The lawn by the water' },
];

export const CHORES = [
  { id: 'plants', kind: 'task', station: 'sunroom', title: 'Water the plants', puzzle: 'hold' },
  { id: 'spices', kind: 'task', station: 'kitchen', title: 'Sort the spice rack', puzzle: 'order' },
  { id: 'table', kind: 'task', station: 'dining', title: 'Set the table', puzzle: 'match' },
  { id: 'radio', kind: 'task', station: 'east-living', title: 'Tune the old radio', puzzle: 'simon' },
  { id: 'lock', kind: 'task', station: 'foyer', title: 'Lock up the front door', puzzle: 'simon' },
  { id: 'router', kind: 'task', station: 'office', title: 'Reboot the Wi-Fi router', puzzle: 'order' },
  { id: 'fold', kind: 'task', station: 'laundry', title: 'Fold the towels', puzzle: 'match' },
  { id: 'frames', kind: 'task', station: 'up-west', title: 'Dust the picture frames', puzzle: 'hold' },
  { id: 'bulb', kind: 'task', station: 'up-east', title: 'Change the hallway bulb', puzzle: 'order' },
  { id: 'games', kind: 'task', station: 'den', title: 'Tidy the board games', puzzle: 'match' },
  { id: 'movie', kind: 'task', station: 'media', title: 'Set up movie night', puzzle: 'simon' },
  { id: 'weights', kind: 'task', station: 'gym', title: 'Re-rack the weights', puzzle: 'order' },
  { id: 'fridge', kind: 'task', station: 'bar', title: 'Restock the drinks fridge', puzzle: 'match' },
  { id: 'receipts', kind: 'task', station: 'b-office', title: 'File the trip receipts', puzzle: 'order' },
  { id: 'sweep', kind: 'task', station: 'screened-patio', title: 'Sweep the screened patio', puzzle: 'hold' },
  { id: 'wipe', kind: 'task', station: 'covered-patio', title: 'Wipe down the patio table', puzzle: 'hold' },
  { id: 'lines', kind: 'task', station: 'dock', title: 'Check the dock lines', puzzle: 'simon' },
  { id: 'ducks', kind: 'task', station: 'shore', title: 'Count the ducks', puzzle: 'order' },

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
];

/** Where meetings happen; scanning its code is how a player rings the bell. */
export const CAMPFIRE = 'campfire';

/** The two stations a storm asks players to secure, far apart on purpose (top floor and lake side of the basement). */
export const STORM_DEFAULT = ['up-east', 'screened-patio'];
