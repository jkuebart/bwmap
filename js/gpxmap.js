/*
 * Copyright 2017, Joachim Kuebart <joachim.kuebart@gmail.com>
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 *   1. Redistributions of source code must retain the above copyright
 *      notice, this list of conditions and the following disclaimer.
 *
 *   2. Redistributions in binary form must reproduce the above copyright
 *      notice, this list of conditions and the following disclaimer in the
 *      documentation and/or other materials provided with the
 *      distribution.
 *
 *   3. Neither the name of the copyright holder nor the names of its
 *      contributors may be used to endorse or promote products derived
 *      from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

import './flatMap.js';
import {
        control,
        DomEvent,
        DomUtil,
        GeoJSON,
        latLngBounds,
        layerGroup,
        map,
        tileLayer
} from 'leaflet';
import vectorTileLayer from 'leaflet-vector-tile-layer';
import require from 'require';
import { summaryPane } from './summary.js';

export const CSS = {
    'DETAILS': 'gpxmap-details',
    'HBOX': 'gpxmap-hbox',
    'SELECT': 'gpxmap-select',
    'TRACK': 'gpxmap-track',
    'VBOX': 'gpxmap-vbox',
    'VIEW': 'gpxmap-view',
};

/**
 * If this looks familiar that's because it's binary search. We find
 * 0 <= i <= array.length such that !pred(i - 1) && pred(i) under the
 * assumption !pred(-1) && pred(length).
 */
function search(array, pred) {
    let le = -1, ri = array.length;
    while (1 + le !== ri) {
        const mi = le + ((ri - le) >> 1);
        if (pred(array[mi])) {
            ri = mi;
        } else {
            le = mi;
        }
    }
    return ri;
}

function yearColour(idx) {
    return ['hsl(',
        170 + 45 * (idx >> 1), ',',
        100, '%,',
        27 * (1 + idx % 2), '%)'
    ].join('');
}

function walkPopup(date, walk) {
    const idx = search(walk.dates, d => date <= d);

    if (walk.dates[idx] !== date) {
        console.log('walkPopup', date, walk);
        return;
    }

    const popup = document.createDocumentFragment();
    let elem0 = document.createElement('div');
    elem0.textContent = [
            [ +date.substr(8, 2)
            , +date.substr(5, 2)
            , +date.substr(0, 4)
            ].join('/'),
            +(walk.distances[idx] / 1000).toFixed(1) +'km',
            `${walk.walkers} walkers`,
            walk.categories.join(' — '),
            '',
        ].join(' — ');

    const anchor = document.createElement('a');
    anchor.setAttribute('href', walk.link);
    anchor.textContent = 'blog';
    elem0.appendChild(anchor);
    popup.appendChild(elem0);

    elem0 = document.createElement('p');
    elem0.textContent = walk.people.sort().join(' • ');
    popup.appendChild(elem0);

    return { 'title': walk.title, 'content': popup };
}

function getFeatureId(walk) {
    return walk.properties.date;
}

function locationState(obj) {
    const state = window.history.state || {};

    if (obj) {
        Object.keys(obj).forEach(k => state[k] = obj[k]);
        window.history.replaceState(state, window.document.title);
    }

    return state;
}

function locationItem(key) {
    return function (value) {
        if (!arguments.length) {
            return locationState()[key];
        }

        locationState({ [key]: value });
        return value;
    }
}

function savedLocation(l) {
    if (!arguments.length) {
        return locationState()['@'];
    }

    const { lat, lng } = L.latLng(l);
    locationState({ '@': [ lat, lng ].map(f => +f.toFixed(6)) });
    return l;
}

const savedZoom = locationItem('z');
const selected = locationItem('s');

function hiddenYear(year, hidden) {
    const state = [].concat(locationState()['y'] || []);
    if (arguments.length < 2) {
        return 0 <= state.indexOf(`${year}`);
    }

    const years = state.reduce((h, k) => (h[k] = true, h), {});
    years[year] = hidden;
    const newState = Object.keys(years).filter(k => years[k]).sort();
    locationState({ 'y': newState.length ? newState : void 0 });
    return hidden;
}

export function gpxmap(id, options) {
    // Create all configured tile layers.
    const tileLayers = options.tileLayers.map(function (layer) {
        return {
            'name': layer.name,
            'tileLayer': tileLayer(layer.url, layer.options),
        };
    });

    // Create layers control.
    const layersControl = control.layers(null, null, { 'hideSingleBase':true });
    tileLayers.forEach(function (layer) {
        layersControl.addBaseLayer(layer.tileLayer, layer.name);
    });

    // Create the DOM structure for our map.
    const domContainer = DomUtil.get(id);
    DomUtil.addClass(domContainer, CSS.VBOX);

    // Create map with an initial tile layer and layers control.
    const gpxmap = map(DomUtil.create('div', CSS.VIEW, domContainer)).
        addControl(control.scale()).
        addControl(layersControl).
        addLayer(tileLayers[0].tileLayer);

    const domDetails = DomUtil.create('div', CSS.DETAILS, domContainer);
    function renderDetails({ title, content }) {
        const h3 = DomUtil.create('h3');

        h3.textContent = title;
        DomUtil.empty(domDetails);
        domDetails.appendChild(h3);
        domDetails.appendChild(content);
    }

    let hover;
    function trackStyle(feature) {
        const date = feature.properties.date;
        const year = date.substr(0, 4);
        return {
            'className': CSS.TRACK,
            'color': yearColour(year - 2011),
            'opacity': hiddenYear(year) ? 0 : date === hover ? 1 : .8,
            'weight': date === hover ? 4 : date === selected() ? 3.5 : 2,
            'interactive': false,
        };
    }
    function mouseStyle(feature) {
        const year = feature.properties.date.substr(0, 4);
        return {
            'opacity': 0,
            'weight': 20,
            'interactive': !hiddenYear(year),
        };
    }

    // This layer shows walking tracks.
    const walkLayer = vectorTileLayer(
        options.url, {
            'pane': 'overlayPane',
            'maxDetailZoom': 13,
            getFeatureId,
            'style': trackStyle,
        }
    ).addTo(gpxmap);

    // This layer has invisible mouse-responsive tracks.
    const mouseLayer = vectorTileLayer(
        options.url, {
            'pane': 'overlayPane',
            'maxDetailZoom': 13,
            getFeatureId,
            'style': mouseStyle,
            'interactive': true, // for Leaflet.VectorGrid
        }
    ).on('mouseover', function (evt) {
        hover = getFeatureId(evt.layer);
        walkLayer.setStyle(trackStyle);
    }).on('mouseout', function () {
        hover = void 0;
        walkLayer.setStyle(trackStyle);
    }).addTo(gpxmap);

    require([ `dA/json!${options.index}` ], function (walks) {
        // Collect all years.
        const years = {};
        walks.flatMap(walk => walk.dates).
            forEach(date => years[date.substr(0, 4)] = true);

        // Build popup from matching index entry.
        mouseLayer.on('click', function (evt) {
            const date = getFeatureId(evt.layer);

            DomEvent.stopPropagation(evt);
            if (date === selected()) {
                return;
            }
            deselect();
            selected(date);
            walkLayer.setStyle(trackStyle);

            renderSummary();
        });

        // Set up a summary pane that reacts when years are toggled.
        const sumPane = summaryPane(walks, renderSummary);
        function renderSummary() {
            const date = selected();

            if (date) {
                const idx = search(walks, walk => date < walk.dates[0]) - 1;
                const popup = walkPopup(date, walks[idx]);
                if (popup) {
                    return renderDetails(popup);
                }
            }

            return renderDetails({
                'title': options.title,
                'content': sumPane.render(),
            });
        }

        function deselect() {
            if (selected()) {
                selected(void 0);
                walkLayer.setStyle(trackStyle);
                renderSummary();
            }
        }
        gpxmap.on('click', deselect);

        // Create one layer group per year and add to the map.
        Object.keys(years).forEach(function (year) {
            const lg = layerGroup().on('add', function () {
                if (hiddenYear(year)) {
                    hiddenYear(year, false);
                    walkLayer.setStyle(trackStyle);
                    mouseLayer.setStyle(mouseStyle);
                }
            }).on('remove', function () {
                if (!hiddenYear(year)) {
                    hiddenYear(year, true);
                    walkLayer.setStyle(trackStyle);
                    mouseLayer.setStyle(mouseStyle);
                }
            });
            if (!hiddenYear(year)) {
                gpxmap.addLayer(lg);
            }
            layersControl.addOverlay(lg, year);
            sumPane.addLayer(lg, year);
        });

        // Adjust the map's viewport when all GPX tracks are loaded
        const bounds = latLngBounds(walks.flatMap(walk => walk.bboxes).
            flatMap(function (bbox) {
                const l = bbox.length >> 1;
                return GeoJSON.coordsToLatLngs([
                    [ bbox[0], bbox[1] ], [ bbox[l], bbox[1 + l] ]
                ]);
            })
        );
        gpxmap.setMaxBounds(bounds.pad(.05));
        if (0 <= savedZoom()) {
            try {
                gpxmap.setView(savedLocation(), savedZoom());
            } catch (exc) {
                console.error(exc);
                gpxmap.fitBounds(bounds);
            }
        } else {
            gpxmap.fitBounds(bounds);
        }
        gpxmap.on('moveend', function () {
            savedLocation(this.getCenter());
            savedZoom(this.getZoom());
        });
    });

    return gpxmap;
}
