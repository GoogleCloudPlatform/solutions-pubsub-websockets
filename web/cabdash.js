/**
 * Copyright 2019, Google, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Front-end Javascript code for the PubSub websockets solution
 */

const refreshRate = 3000;
const host = document.location.host;
const maxNumRideCards = 9;
const rideKeys = ['ride_id', 'ride_status', 'timestamp',
  'latitude', 'longitude', 'meter_reading',
  'passenger_count', 'sequenceNumber'];

let rides = {};
let lag = 0;
let lastRefresh = new Date().getTime();
let totalMeter = 0;
let totalUpdates = 0;
let totalPassengers = 0;
let avgDensity = 0;
let meterPerPassenger = 0;
let messageSeq = 1;
let activeRides = 0;
let ws = undefined;

/**
 * Calculate the rate of inbound message processing
 * @param {number} updateCount - the cumulative number of updates 
 * @param {number} totalSeconds - the number of seconds since last refresh
 * @returns {}
 */
function calculateMessageRate(updateCount, totalSeconds) {
  return (updateCount / totalSeconds).toFixed(2);
}

/**
 * Render the UI for displying per-ride count of passengers
 * @param {number} count - the number of passsengers to render 
 * @returns {string}
 */
function makePassengers(count) {
  let span = '<br>';
  if (count > 0) {
    for (let i = 0; i < count; i++) {
      span += '<i class="material-icons">person</i>';
      if (i === count - 1) {
        return span;
      }
    }
  } else {
    span += '<i class="material-icons">refresh</icon>';
    return span;
  }
}

/**
 * Update the total amount display on consolidated meter statistic
 * @param {Object} ride - the ride to consider
 * @param {boolean} isNewRide - is this the first time the ride was observed?
 */
function updateMeterTotal(ride, isNewRide) {
  if (ride.ride_status === 'dropoff') {
    totalPassengers -= ride.passenger_count;
    totalMeter -= ride.meter_reading;
  } else if (isNewRide) {
    totalPassengers += ride.passenger_count;
    totalMeter += ride.meter_reading;
  } else { // increment meter by delta
    let existingRide = rides[ride.ride_id];
    if (existingRide) {
      totalMeter += (ride.meter_reading - existingRide.meter_reading);
    }
  }
}

/**
 * Update the metrics to consider an individual ride 
 * @param {Object} ride - the ride to consider
 * @param {boolean} isNewRide - is this the first observation of this ride?
 */
function updateStats(ride, isNewRide) {
  totalUpdates += 1;
  updateMeterTotal(ride, isNewRide);
  avgDensity = (totalPassengers / activeRides).toFixed(2);

  const rate = calculateMessageRate(totalUpdates, (new Date().getTime() - lastRefresh) / 1000);
  let rateDisplay = document.getElementById("messageRate");
  rateDisplay.innerHTML = `${rate} mps`;

  lag = (new Date().getTime() - Date.parse(ride.timestamp)) / 1000;
  let lagDisplay = document.getElementById("lag");
  lagDisplay.innerHTML = parseFloat(lag).toFixed(4) + 's';

  let active = document.getElementById("activeRides");
  active.innerHTML = activeRides;

  let meter = document.getElementById("totalMeter");
  meter.innerHTML = '$' + parseFloat(totalMeter).toFixed(2);

  let mpp = '$' + (totalMeter / totalPassengers).toFixed(2)
  let passengers = document.getElementById("totalPassengers");
  passengers.innerHTML = `${totalPassengers} (${avgDensity} / ${mpp})`;
}

/**
 * Clear the individual ride display panels from the UI
 */
function clearCards() {
  const node = document.getElementById('containerDiv');
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
  document.getElementById("alert-message").style.opacity = 0;
}

/**
 * Tag each ride with a sequenced identifier, add ride to global array, increment counter
 * @param {Object} ride - the ride to sequence
 */
function sequence(ride) {
  ride.sequenceNumber = messageSeq;
  messageSeq += 1;
  rides[ride.ride_id] = ride;
}

/**
 * Render individual pickup or dropoff events
 * @param {Object} ride - the ride being considered
 */
function flashMessage(ride) {
  const elem = document.getElementById("alert-message");
  if (elem) {
    const lat = formatCoordinate(ride.latitude.toString());
    const lon = formatCoordinate(ride.longitude.toString());
    const latlng = `${lat},${lon}`;
    const link = `<a target="_blank" href="https://www.google.com/maps/place/${latlng}">${latlng}</a>`;
    const icon = (ride.ride_status === 'pickup')
      ? 'directions_run'
      : 'done';
    const msg = `
      <icon class="material-icons icon" title="${ride.ride_status}">${icon}</icon>
      <icon class="material-icons icon">local_taxi</icon>&nbsp;&nbsp;${ride.ride_id}
      &nbsp;&nbsp;<icon class="material-icons icon">location_on</icon>&nbsp;&nbsp;${link}
    `;
    elem.innerHTML = msg;
    elem.style.opacity = 1;
  }
}

/**
 * Trim particularly long coordinates
 * @param {String} coord - the latitude or longitude to format
 */
function formatCoordinate(coord) {
  if (!coord) {
    return undefined;
  }
  const idx = coord.indexOf('.');
  return coord.substring(0, idx + 5);
}

/**
 * Processes an individual ride event
 * @param {Object} ride - the ride to process
 */
function processRide(ride) {
  let container = document.getElementById("containerDiv");
  let isNewRide = false;
  if (!rides[ride.ride_id]) {
    isNewRide = true;
    activeRides += 1;
    sequence(ride);
  } else {
    if (ride.ride_status === 'dropoff') {
      if (rides[ride.ride_id]) {
        flashMessage(ride);
        activeRides -= 1;
        delete rides[ride.ride_id];
      }
    } else {
      if (ride.ride_status === 'pickup') {
        flashMessage(ride);
      }
      sequence(ride);
    }
  }
  updateStats(ride, isNewRide);
}

/**
 * Refresh an individual UI ride card with another ride's data
 * @param {Object} ride - the ride to consider
 * @param {number} cardIndex - the index of the card to update
 */
function refreshCard(ride, cardIndex) {
  if (ride) {
    const children = document.getElementById('containerDiv').childNodes;
    if (children.length < maxNumRideCards) {
      document.getElementById('containerDiv').appendChild(makeCard(ride, cardIndex));
    } else {
      for (let key of rideKeys) {
        let elem = document.getElementById(`${key}-${cardIndex}`);
        if (elem) {
          switch (key) {
            case 'meter_reading':
              elem.innerHTML = '$' + parseFloat(ride[key]).toFixed(2);
              break;
            case 'sequenceNumber':
              elem.innerHTML = '#' + ride[key];
              break;
            case 'passenger_count':
              elem.title = `${ride[key]} passengers in ride ${ride.ride_id}`;
              elem.innerHTML = makePassengers(ride[key]);
              break;
            case 'ride_status':
              elem.title = JSON.stringify(ride, undefined, 1)
                .replace(/\"/g, '').replace(/{/g, '').replace(/}/g, '');
              elem.innerHTML = headerIcon(ride[key]);
              break;
            case 'timestamp':
              elem.innerHTML = new Date(ride[key]).toISOString();
              break;
            default:
              elem.innerHTML = ride[key]
          }
        }
      }
    }
  }
}

/**
 * Manufacture the DOM element for an individual ride card
 * @param {object} ride - the ride to consider
 * @param {number} index - the index of the card to create
 */
function makeCard(ride, index) {
  let id = ride ? ride.ride_id : '?';
  let card = document.createElement("div");
  card.setAttribute("id", index + '-card');
  card.setAttribute("class",
    "card taxi-card border-dark flex-fill text-dark mb-3 p-3 fadeIn");
  card.appendChild(makeHeader(ride, index));
  card.appendChild(makeBody(ride, index));
  card.appendChild(makeFooter(ride, index));

  return card;
}

/**
 * Create the card-body of an individual card
 * @param {Object} ride - the ride to consider
 * @param {number} index - the index of the card to render
 */
function makeBody(ride, index) {
  const body = document.createElement("div");
  const id = ride ? ride.ride_id : '?';
  const meter = parseFloat(ride.meter_reading).toFixed(2);
  body.setAttribute("id", `${index}-body`);
  body.setAttribute("class", "card-body");
  body.innerHTML = `
    <span style="vertical-align: middle; align-items: center;" class="fare">
    <label class="fare" id="meter_reading-${index}" class="stat">\$${meter}</label>
  `;

  return body;
}

/**
 * Return the icon to render in the header based on ride status
 * @param {string} rideStatus - the status of the ride
 */
function headerIcon(rideStatus) {
  let val = 'traffic';
  switch (rideStatus) {
    case 'dropoff':
      val = 'done';
      break;
    case 'pickup':
      val = 'directions_run';
      break;
  }
  return val;
}

/**
 * Create the card-header of an individual card
 * @param {Object} ride - the ride to consider
 * @param {number} index - the index of the card header to render
 */
function makeHeader(ride, index) {
  let header = document.createElement("div");
  let id = ride ? ride.ride_id : '?';
  const icon = headerIcon(ride.ride_status);
  const passengers = makePassengers(ride.passenger_count);
  const ridedump = JSON.stringify(ride, undefined, 1)
    .replace(/\"/g, '').replace(/{/g, '').replace(/}/g, '');
  header.setAttribute("id", `${index}-header`);
  header.setAttribute("class", "card-header font-weight-bold text-truncate");
  header.innerHTML = `
    <span id="sequenceNumber-${index}" class="stat" style="padding: 1px; font-size: 9px;">
    #${ride.sequenceNumber}
    </span>
    <br>
    <span style="vertical-align:middle;">
    <icon id="ride_status-${index}" title="${ridedump}" class="material-icons">${icon}</icon>
    <icon class="material-icons">local_taxi</icon>
    </span>
    <span class="stat" id="ride_id-${index}">${ride.ride_id}</span><br>
    <span id="passenger_count-${index}">
    ${passengers}
    </span>
    </span>
    `;
  return header;
}

/**
 * Create the card-footer of an individual card
 * @param {Object} ride - the ride to consider
 * @param {number} index - the index of the card to render
 */
function makeFooter(ride, index) {
  let isodate = new Date(ride.timestamp).toISOString();
  let footer = document.createElement("span");
  footer.setAttribute("id", `${index}-footer`);
  footer.setAttribute("class", "card-footer text-truncate");
  footer.innerHTML = '<icon class="material-icons" style="font-size:18px">date_range</icon>';
  footer.innerHTML += `&nbsp;&nbsp;<span id="timestamp-${index}">${isodate}</span>`;

  return footer;
}

/**
 * Create or destroy the websocket connection
 */
function connect() {
  if (!ws || ws.readyState !== 1) {
    ws = new WebSocket('ws://' + document.location.host);
    ws.onopen = function () {
      document.getElementById("taxilogo").setAttribute("class", "material-icons connected");
    }
    ws.onclose = function () {
      document.getElementById("taxilogo").setAttribute("class", "material-icons disconnected");
    }
    ws.onerror = function () {
      document.getElementById("taxilogo").setAttribute("class", "material-icons disconnected");
    }
    clearStats();
    clearCards();
    ws.onmessage = function (event) {
      let ride = JSON.parse(event.data);
      if (ride) {
        processRide(ride);
      }
    }
  } else {
    ws.close();
    ws = undefined;
    rides = {};
  }
}

/**
 * Initialize statistics for message stream
 */
function clearStats() {
  const stats = document.getElementsByClassName('stat');
  for (let stat of stats) {
    stat.innerHTML = '0';
  }
  totalMeter = 0;
  totalUpdates = 0;
  totalPassengers = 0;
  avgDensity = 0;
  meterPerPassenger = 0;
  activeRides = 0;
  rides = {};
  lastRefresh = new Date().getTime();
  lag = 0;
  messageSeq = 0;
}

/**
 * Function called periodically based on global refreshRate
 * to sample and render indivdual ride events
 */
function cycle() {
  if (ws && ws.readyState === 1) {
    const rideSample = Object.keys(rides).slice(activeRides - maxNumRideCards);
    for (let i = 0; i < maxNumRideCards; i++) {
      const ride = rides[rideSample[i]];
      if (ride) {
        refreshCard(ride, i);
      }
    }
  }
}

/**
 * A routine run when the DOM content has been loaded
 * for the page
 */
const load = function () {
  setInterval(cycle, refreshRate);
}
document.addEventListener('DOMContentLoaded', load, false);
