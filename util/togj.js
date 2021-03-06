#!/usr/bin/env node
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

const assert = require('assert');
const fs = require('fs');
const togeojson = require('@mapbox/togeojson');
const DOMParser = require('xmldom').DOMParser;

// Fake browser environment to load leaflet.
global.document = {
    createElement() { return {}; },
    'documentElement': { 'style': {} },
};
global.navigator = { 'platform': '', 'userAgent': '' };
global.window = { 'devicePixelRatio': 1 };
const L = require('leaflet');

// Missing monadic operation.
if ('function' !== typeof Array.prototype.flatMap) {
    Object.defineProperty(Array.prototype, 'flatMap', {
        'value': function () {
            return Array.prototype.concat.apply([],
                Array.prototype.map.apply(this, arguments)
            );
        },
    });
}

/**
 * Invoke `func` with a start and end index into `array` for each range of
 * elements that are equivalent according to `equal`.
 */
function forEachUniqueRange(array, equal, func) {
    const res = [];
    for (let lo = 0, hi; lo !== array.length; lo = hi) {
        for (hi = 1 + lo; hi !== array.length && equal(array[lo], array[hi]); ++hi)
            ;
        res.push(func(lo, hi, array));
    }
    return res;
}

/**
 * Compute the length of a Polyline, in radians.
 */
function distance(latLngs) {
    var Earth = L.CRS.Earth;
    if (0 === latLngs.length) {
        return 0;
    }

    // Generalise everything to MultiPolylines.
    if (!latLngs[0].hasOwnProperty('length')) {
        latLngs = [ latLngs ];
    }

    return latLngs.reduce(function (dist, seg) {
        var i, p, q;

        if (1 < seg.length) {
            for (i = seg.length - 1, p = seg[i]; 0 <= i; p = q, --i) {
                q = seg[i];
                dist += Earth.distance(p, q);
            }
        }
        return dist;
    }, 0);
}

/**
 * Load the named GPX file as GeoJSON and return an array of features. The
 * file name is added to every feature's properties.
 */
function gpxToJson(gpxFileName) {
    const gpx = togeojson.gpx(new DOMParser().parseFromString(
        fs.readFileSync(gpxFileName, 'utf8')
    ));
    assert.equal(gpx.type, 'FeatureCollection');
    return gpx.features.map(function (feature) {
        assert.equal(feature.type, 'Feature');
        const properties = Object.assign({}, feature.properties, {
            'gpxFileName': gpxFileName.substr(1 + gpxFileName.lastIndexOf('/')),
        });
        return { 'type': 'Feature', properties, 'geometry': feature.geometry };
    });
}

/**
 * If the feature is a MultiLine, split it up into an array of Lines while
 * preserving properties. If there is a 'coordTimes' property, it is
 * treated specially and the 'time' property is adjusted accordingly.
 */
function multiSplit(feature) {
    assert.equal(feature.type, 'Feature');
    if ('MultiLineString' !== feature.geometry.type) {
        return [ feature ];
    }

    return feature.geometry.coordinates.map(function (coordinates, i) {
        // Clone properties for each generated feature.
        const properties = Object.assign({}, feature.properties);

        // Select appropriate coordTimes.
        if (properties.coordTimes) {
            assert(i < properties.coordTimes.length);
            assert.equal(properties.coordTimes[i].length, coordinates.length);
            assert.equal(properties.time, properties.coordTimes[0][0]);
            properties.coordTimes = properties.coordTimes[i];
            properties.time = properties.coordTimes[0];
        }

        return {
            'type': 'Feature',
            properties,
            'geometry': { 'type': 'LineString', coordinates },
        };
    });
}

/**
 * If the Line feature has a 'coordTimes' property which spans several days,
 * split the feature into one Line per day.
 */
function dateSplit(feature) {
    assert.equal(feature.type, 'Feature');
    if ('LineString' !== feature.geometry.type ||
        !feature.properties || !feature.properties.coordTimes ||
        feature.properties.coordTimes.length !== feature.geometry.coordinates.length)
    {
        const properties = Object.assign({}, feature.properties, {
            'date': (feature.properties.time || feature.properties.gpxFileName).substr(0, 10),
        });
        return [ {
            'type': 'Feature',
            properties,
            'geometry': feature.geometry,
        } ];
    }

    assert.equal(
        feature.properties.coordTimes.length,
        feature.geometry.coordinates.length,
        `${feature.properties.gpxFileName}: ${feature.properties.time}`
    );
    return forEachUniqueRange(
        feature.properties.coordTimes,
        (lhs, rhs) => lhs.substr(0, 10) === rhs.substr(0, 10),
        function (lo, hi) {
            // Clone properties for each generated feature.
            const properties = Object.assign({}, feature.properties);

            // Split up coordTimes and coordinates.
            properties.coordTimes = properties.coordTimes.slice(lo, hi);
            properties.time = properties.coordTimes[0];
            properties.date = properties.time.substr(0, 10);
            const coordinates = feature.geometry.coordinates.slice(lo, hi);
            return {
                'type': 'Feature',
                properties,
                'geometry': { 'type': 'LineString', coordinates },
            };
        }
    );
}

/**
 * Compare two GeoJSON features according to their 'time' property, falling
 * back to 'date'.
 */
function timeCompare(lhs, rhs) {
    assert.equal(lhs.type, 'Feature');
    assert.equal(rhs.type, 'Feature');
    const time0 = lhs.properties.time || lhs.properties.date;
    const time1 = rhs.properties.time || rhs.properties.date;
    return time0 < time1 ? -1 : time1 < time0 ? 1 : 0;
}

/**
 * Merge a range of lines into a MultiLine.
 */
function mergeLines(lo, hi, features) {
    if (hi - lo <= 1) {
        return features[lo];
    }

    const slice = features.slice(lo, hi);
    assert(slice.every(feature => 'LineString' === feature.geometry.type));

    // Merge coordTimes and coordinates into nested arrays.
    const properties = { 'date': slice[0].properties.date };
    if (slice[0].properties.coordTimes) {
        properties.coordTimes = slice.map(function (walk) {
            assert.equal(
                walk.properties.coordTimes.length,
                walk.geometry.coordinates.length
            );
            return walk.properties.coordTimes;
        });
        properties.time = properties.coordTimes[0][0];
    }
    const coordinates = slice.map(walk => walk.geometry.coordinates);

    return {
        'type': 'Feature',
        properties,
        'geometry': { 'type': 'MultiLineString', coordinates },
    };
}

/**
 * Compute bounding box and distance for Lines and MultiLines.
 */
function addBbox(feature) {
    assert.equal(feature.type, 'Feature');
    if (!feature.geometry.type.endsWith('LineString')) {
        return feature;
    }

    // Calculate bounds.
    const geometry = feature.geometry;
    const depth = 'LineString' === geometry.type ? 0 : 1;
    const latLngs = L.GeoJSON.coordsToLatLngs(geometry.coordinates, depth);
    const bounds = L.polyline(latLngs).getBounds();

    // Convert to GeoJSON bounding box.
    const bbox = [ bounds.getSouthWest().lng, bounds.getSouthWest().lat,
                   bounds.getNorthEast().lng, bounds.getNorthEast().lat ];
    if (3 === (depth ? geometry.coordinates[0][0] : geometry.coordinates[0]).length) {
        bbox.splice(2, 0, bounds.getSouthWest().alt);
        bbox.splice(5, 0, bounds.getNorthEast().alt);
    } else {
        assert.equal((depth ? geometry.coordinates[0][0] : geometry.coordinates[0]).length, 2);
    }

    // Calculate distance while we have latLngs.
    const properties = {
        'date': feature.properties.date,
        'distance':  Math.round(distance(latLngs)),
    };

    return { 'type': 'Feature', bbox, properties, geometry };
}


if (process.argv.length < 3) {
    process.stderr.write(`usage: ${process.argv[1]} directory
        directory       Should contain any number of .gpx files.
`);
    process.exit(1);
}

const GPXDIR = process.argv[2];

// An array of GeoJSON features, sorted by date.
const walks = fs.readdirSync(GPXDIR).
    filter(file => file.endsWith('.gpx')).
    flatMap(file => gpxToJson(`${GPXDIR}/${file}`)).
    flatMap(multiSplit).
    filter(feature => 'LineString' === feature.geometry.type).
    flatMap(dateSplit).
    sort(timeCompare);

// Merge GeoJSON features for the same date by optionally creating MultiLines.
const geojson = {
    'type': 'FeatureCollection',
    'features': forEachUniqueRange(
        walks,
        (lhs, rhs) => lhs.properties.date === rhs.properties.date,
        mergeLines
    ).map(addBbox),
};

process.stdout.write(JSON.stringify(geojson, null, ' '));
