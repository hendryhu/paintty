import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { muxH264Mp4 } from '../src/lib/mp4.js';

function readU16(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset);
}

function readU32(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset);
}

function readText(data, offset, length) {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function parseBoxes(data, start = 0, end = data.byteLength) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    assert.ok(end - offset >= 8, 'box header fits inside its parent');
    const size = readU32(data, offset);
    assert.ok(size >= 8, 'box has a valid 32-bit size');
    assert.ok(offset + size <= end, 'box fits inside its parent');
    boxes.push({
      type: readText(data, offset + 4, 4),
      start: offset,
      end: offset + size,
      size,
    });
    offset += size;
  }
  assert.equal(offset, end, 'child boxes consume their parent');
  return boxes;
}

function required(boxes, type) {
  const box = boxes.find((candidate) => candidate.type === type);
  assert.ok(box, `${type} box exists`);
  return box;
}

function children(data, parent) {
  return parseBoxes(data, parent.start + 8, parent.end);
}

function readDescriptor(data, offset, limit) {
  assert.ok(offset < limit, 'descriptor tag fits inside its parent');
  const tag = data[offset++];
  let size = 0;
  let terminated = false;
  for (let i = 0; i < 4; i++) {
    assert.ok(offset < limit, 'descriptor size fits inside its parent');
    const value = data[offset++];
    size = size * 0x80 + (value & 0x7f);
    if (!(value & 0x80)) {
      terminated = true;
      break;
    }
  }
  assert.ok(terminated, 'descriptor has a valid expandable size');
  assert.ok(offset + size <= limit, 'descriptor payload fits inside its parent');
  return { tag, payloadStart: offset, end: offset + size, size };
}

function trackParts(data, trak) {
  const trakChildren = children(data, trak);
  const tkhd = required(trakChildren, 'tkhd');
  const mdia = required(trakChildren, 'mdia');
  const mdiaChildren = children(data, mdia);
  const mdhd = required(mdiaChildren, 'mdhd');
  const hdlr = required(mdiaChildren, 'hdlr');
  const minf = required(mdiaChildren, 'minf');
  const minfChildren = children(data, minf);
  const stbl = required(minfChildren, 'stbl');
  return {
    tkhd,
    mdhd,
    hdlr,
    minfChildren,
    tables: children(data, stbl),
  };
}

let passed = 0;
let failed = 0;

async function test(name, run) {
  try {
    await run();
    passed++;
  } catch (error) {
    failed++;
    console.error('FAIL ' + name, error.stack);
  }
}

await test('muxes an independently parseable constant-frame-rate AVC file', () => {
  const decoderConfig = new Uint8Array([
    1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 2, 0x68, 0xee,
  ]);
  const sampleData = [
    new Uint8Array([0, 0, 0, 1, 0x65]),
    new Uint8Array([0, 0, 0]),
    new Uint8Array([0, 0, 0, 2, 0x41, 0x22]),
  ];
  const output = muxH264Mp4({
    samples: [
      { data: sampleData[0], key: true },
      { data: sampleData[1], key: false },
      { data: sampleData[2], key: true },
    ],
    avcDecoderConfig: decoderConfig,
    width: 80,
    height: 30,
    timescale: 24,
  });

  assert.ok(output instanceof Uint8Array);
  assert.equal(output.byteLength, 682);
  assert.equal(
    createHash('sha256').update(output).digest('hex'),
    '5f4726d0587de643e8f64f77ed888c3e841a6f0c6ee13a5d996917f01eba5814',
    'the established video-only byte stream remains unchanged',
  );
  const top = parseBoxes(output);
  assert.deepEqual(top.map((box) => box.type), ['ftyp', 'moov', 'mdat']);
  assert.equal(readText(output, top[0].start + 8, 4), 'isom');
  assert.match(readText(output, top[0].start + 16, top[0].size - 16), /avc1/);

  const moovChildren = children(output, top[1]);
  const mvhd = required(moovChildren, 'mvhd');
  const trak = required(moovChildren, 'trak');
  const trakChildren = children(output, trak);
  const tkhd = required(trakChildren, 'tkhd');
  const mdia = required(trakChildren, 'mdia');
  const mdiaChildren = children(output, mdia);
  const mdhd = required(mdiaChildren, 'mdhd');
  const hdlr = required(mdiaChildren, 'hdlr');
  const minf = required(mdiaChildren, 'minf');
  const minfChildren = children(output, minf);
  const stbl = required(minfChildren, 'stbl');
  const tables = children(output, stbl);

  assert.equal(readU32(output, mvhd.start + 20), 24);
  assert.equal(readU32(output, mvhd.start + 24), 3);
  assert.equal(readU32(output, tkhd.start + 8) & 0xffffff, 7);
  assert.equal(readU32(output, tkhd.start + 28), 3);
  assert.equal(readU32(output, tkhd.end - 8), 80 * 0x10000);
  assert.equal(readU32(output, tkhd.end - 4), 30 * 0x10000);
  assert.equal(readU32(output, mdhd.start + 20), 24);
  assert.equal(readU32(output, mdhd.start + 24), 3);
  assert.equal(readText(output, hdlr.start + 16, 4), 'vide');

  const stsd = required(tables, 'stsd');
  assert.equal(readU32(output, stsd.start + 12), 1);
  const [avc1] = parseBoxes(output, stsd.start + 16, stsd.end);
  assert.equal(avc1.type, 'avc1');
  assert.equal(readU16(output, avc1.start + 32), 80);
  assert.equal(readU16(output, avc1.start + 34), 30);
  const [avcC] = parseBoxes(output, avc1.start + 86, avc1.end);
  assert.equal(avcC.type, 'avcC');
  assert.deepEqual(output.subarray(avcC.start + 8, avcC.end), decoderConfig);

  const stts = required(tables, 'stts');
  assert.deepEqual([
    readU32(output, stts.start + 12),
    readU32(output, stts.start + 16),
    readU32(output, stts.start + 20),
  ], [1, 3, 1]);

  const stsc = required(tables, 'stsc');
  assert.deepEqual([
    readU32(output, stsc.start + 12),
    readU32(output, stsc.start + 16),
    readU32(output, stsc.start + 20),
    readU32(output, stsc.start + 24),
  ], [1, 1, 3, 1]);

  const stsz = required(tables, 'stsz');
  assert.equal(readU32(output, stsz.start + 12), 0);
  assert.equal(readU32(output, stsz.start + 16), 3);
  assert.deepEqual([
    readU32(output, stsz.start + 20),
    readU32(output, stsz.start + 24),
    readU32(output, stsz.start + 28),
  ], [5, 3, 6]);

  const stss = required(tables, 'stss');
  assert.equal(readU32(output, stss.start + 12), 2);
  assert.deepEqual([
    readU32(output, stss.start + 16),
    readU32(output, stss.start + 20),
  ], [1, 3]);

  const stco = required(tables, 'stco');
  assert.equal(readU32(output, stco.start + 12), 1);
  assert.equal(readU32(output, stco.start + 16), top[2].start + 8);
  assert.deepEqual(
    output.subarray(top[2].start + 8, top[2].end),
    new Uint8Array(sampleData.flatMap((sample) => [...sample])),
  );
});

await test('muxes WebCodecs-style AAC chunks as an independent audio track', () => {
  const decoderConfig = new Uint8Array([0x12, 0x10]);
  const videoData = new Uint8Array([0, 0, 1, 0x65]);
  const audioData = [
    new Uint8Array([0x21, 0x22]),
    new Uint8Array([0x31, 0x32, 0x33]),
    new Uint8Array([0x41, 0x42, 0x43, 0x44]),
  ];
  const encodedChunk = (data, timestamp, duration) => ({
    timestamp,
    duration,
    byteLength: data.byteLength,
    copyTo(destination) {
      destination.set(data);
    },
  });
  const output = muxH264Mp4({
    samples: [{ data: videoData, key: true }],
    avcDecoderConfig: new Uint8Array([1, 0x42, 0, 0x1e]),
    width: 16,
    height: 9,
    timescale: 30,
    audio: {
      samples: [
        encodedChunk(audioData[0], 0, 21_333),
        encodedChunk(audioData[1], 21_333, 21_334),
        encodedChunk(audioData[2], 42_667, 21_333),
      ],
      decoderConfig: {
        codec: 'mp4a.40.2',
        sampleRate: 48_000,
        numberOfChannels: 2,
        description: decoderConfig,
      },
    },
  });

  const top = parseBoxes(output);
  assert.deepEqual(top.map((box) => box.type), ['ftyp', 'moov', 'mdat']);
  const moovChildren = children(output, top[1]);
  assert.deepEqual(moovChildren.map((box) => box.type), ['mvhd', 'trak', 'trak']);
  const mvhd = required(moovChildren, 'mvhd');
  const tracks = moovChildren.filter((box) => box.type === 'trak');
  const video = trackParts(output, tracks[0]);
  const audio = trackParts(output, tracks[1]);

  assert.equal(readU32(output, mvhd.start + 20), 30);
  assert.equal(readU32(output, mvhd.start + 24), 2, 'audio extends the movie to two video ticks');
  assert.equal(readU32(output, mvhd.end - 4), 3);
  assert.equal(readText(output, video.hdlr.start + 16, 4), 'vide');
  assert.equal(readText(output, audio.hdlr.start + 16, 4), 'soun');
  assert.equal(readText(output, audio.hdlr.start + 32, 13), 'SoundHandler\0');

  assert.equal(readU32(output, video.tkhd.start + 20), 1);
  assert.equal(readU32(output, video.tkhd.start + 28), 1);
  assert.equal(readU32(output, audio.tkhd.start + 20), 2);
  assert.equal(readU32(output, audio.tkhd.start + 28), 2);
  assert.equal(readU16(output, audio.tkhd.start + 44), 0x0100);
  assert.equal(readU32(output, audio.tkhd.end - 8), 0);
  assert.equal(readU32(output, audio.tkhd.end - 4), 0);
  assert.equal(readU32(output, audio.mdhd.start + 20), 48_000);
  assert.equal(readU32(output, audio.mdhd.start + 24), 3_072);
  assert.deepEqual(audio.minfChildren.map((box) => box.type), ['smhd', 'dinf', 'stbl']);
  const smhd = required(audio.minfChildren, 'smhd');
  assert.equal(readU32(output, smhd.start + 8), 0);
  assert.equal(readU32(output, smhd.start + 12), 0);

  assert.deepEqual(
    audio.tables.map((box) => box.type),
    ['stsd', 'stts', 'stsc', 'stsz', 'stco'],
  );
  const stsd = required(audio.tables, 'stsd');
  assert.equal(readU32(output, stsd.start + 12), 1);
  const [mp4a] = parseBoxes(output, stsd.start + 16, stsd.end);
  assert.equal(mp4a.type, 'mp4a');
  assert.equal(readU16(output, mp4a.start + 14), 1);
  assert.equal(readU16(output, mp4a.start + 24), 2);
  assert.equal(readU16(output, mp4a.start + 26), 16);
  assert.equal(readU32(output, mp4a.start + 32), 48_000 * 0x10000);
  const [esds] = parseBoxes(output, mp4a.start + 36, mp4a.end);
  assert.equal(esds.type, 'esds');
  assert.equal(readU32(output, esds.start + 8), 0);

  const es = readDescriptor(output, esds.start + 12, esds.end);
  assert.equal(es.tag, 0x03);
  assert.equal(es.end, esds.end);
  assert.equal(readU16(output, es.payloadStart), 2);
  assert.equal(output[es.payloadStart + 2], 0);
  const decoder = readDescriptor(output, es.payloadStart + 3, es.end);
  assert.equal(decoder.tag, 0x04);
  assert.equal(output[decoder.payloadStart], 0x40);
  assert.equal(output[decoder.payloadStart + 1], 0x15);
  const specific = readDescriptor(output, decoder.payloadStart + 13, decoder.end);
  assert.equal(specific.tag, 0x05);
  assert.equal(specific.end, decoder.end);
  assert.deepEqual(output.subarray(specific.payloadStart, specific.end), decoderConfig);
  const sl = readDescriptor(output, decoder.end, es.end);
  assert.equal(sl.tag, 0x06);
  assert.deepEqual(output.subarray(sl.payloadStart, sl.end), new Uint8Array([2]));
  assert.equal(sl.end, es.end);

  const stts = required(audio.tables, 'stts');
  assert.deepEqual([
    readU32(output, stts.start + 12),
    readU32(output, stts.start + 16),
    readU32(output, stts.start + 20),
  ], [1, 3, 1_024]);
  const stsc = required(audio.tables, 'stsc');
  assert.deepEqual([
    readU32(output, stsc.start + 12),
    readU32(output, stsc.start + 16),
    readU32(output, stsc.start + 20),
    readU32(output, stsc.start + 24),
  ], [1, 1, 3, 1]);
  const stsz = required(audio.tables, 'stsz');
  assert.deepEqual([
    readU32(output, stsz.start + 12),
    readU32(output, stsz.start + 16),
    readU32(output, stsz.start + 20),
    readU32(output, stsz.start + 24),
    readU32(output, stsz.start + 28),
  ], [0, 3, 2, 3, 4]);

  const videoOffset = readU32(output, required(video.tables, 'stco').start + 16);
  const audioOffset = readU32(output, required(audio.tables, 'stco').start + 16);
  assert.equal(videoOffset, top[2].start + 8);
  assert.equal(audioOffset, videoOffset + videoData.byteLength);
  assert.deepEqual(output.subarray(videoOffset, audioOffset), videoData);
  assert.deepEqual(
    output.subarray(audioOffset, top[2].end),
    new Uint8Array(audioData.flatMap((sample) => [...sample])),
  );
});

await test('copies exact typed-array windows', () => {
  const backing = new Uint8Array([9, 1, 2, 3, 8]);
  const configBacking = new Uint8Array([7, 1, 0x42, 0, 0x1e, 6]);
  const sample = backing.subarray(1, 4);
  const config = new DataView(configBacking.buffer, 1, 4);
  const output = muxH264Mp4({
    samples: [{ data: sample, key: true }],
    avcDecoderConfig: config,
    width: 1,
    height: 1,
    timescale: 60,
  });
  backing.fill(0);
  configBacking.fill(0);

  const top = parseBoxes(output);
  assert.deepEqual(output.subarray(top[2].start + 8), new Uint8Array([1, 2, 3]));
  const trak = required(children(output, top[1]), 'trak');
  const mdia = required(children(output, trak), 'mdia');
  const minf = required(children(output, mdia), 'minf');
  const stbl = required(children(output, minf), 'stbl');
  const tables = children(output, stbl);
  const stss = required(tables, 'stss');
  assert.equal(readU32(output, stss.start + 12), 1);
  assert.equal(readU32(output, stss.start + 16), 1);
  const stsd = required(tables, 'stsd');
  const [avc1] = parseBoxes(output, stsd.start + 16, stsd.end);
  const [avcC] = parseBoxes(output, avc1.start + 86, avc1.end);
  assert.deepEqual(output.subarray(avcC.start + 8, avcC.end), new Uint8Array([1, 0x42, 0, 0x1e]));
});

await test('rejects dimensions, timing, and encoded data that cannot form a video', () => {
  const valid = {
    samples: [{ data: new Uint8Array([1]), key: true }],
    avcDecoderConfig: new Uint8Array([1]),
    width: 80,
    height: 30,
    timescale: 24,
  };
  assert.throws(() => muxH264Mp4({ ...valid, samples: [] }), /at least one/i);
  assert.throws(() => muxH264Mp4({ ...valid, width: 0 }), /width/i);
  assert.throws(() => muxH264Mp4({ ...valid, height: 65536 }), /height/i);
  assert.throws(() => muxH264Mp4({ ...valid, timescale: 1.5 }), /timescale/i);
  assert.throws(
    () => muxH264Mp4({ ...valid, samples: [{ data: new Uint8Array([1]), key: false }] }),
    /first.*keyframe/i,
  );
  assert.throws(() => muxH264Mp4({ ...valid, avcDecoderConfig: new Uint8Array() }), /cannot be empty/i);
  assert.throws(
    () => muxH264Mp4({ ...valid, samples: [{ data: new Uint8Array(), key: true }] }),
    /samples\[0\].*empty/i,
  );
});

await test('rejects malformed AAC configuration, chunks, and timelines', () => {
  const validAudio = {
    samples: [
      { data: new Uint8Array([1]), timestamp: 0, duration: 21_333 },
      { data: new Uint8Array([2]), timestamp: 21_333, duration: 21_334 },
    ],
    decoderConfig: {
      codec: 'mp4a.40.2',
      sampleRate: 48_000,
      numberOfChannels: 2,
      description: new Uint8Array([0x12, 0x10]),
    },
  };
  const valid = {
    samples: [{ data: new Uint8Array([1]), key: true }],
    avcDecoderConfig: new Uint8Array([1]),
    width: 80,
    height: 30,
    timescale: 24,
  };
  const muxAudio = (audio) => muxH264Mp4({ ...valid, audio });

  assert.throws(() => muxAudio([]), /audio.*object/i);
  assert.throws(() => muxAudio({ ...validAudio, samples: [] }), /audio\.samples.*at least one/i);
  assert.throws(() => muxAudio({ ...validAudio, decoderConfig: null }), /decoderConfig/i);
  assert.throws(
    () => muxAudio({
      ...validAudio,
      decoderConfig: { ...validAudio.decoderConfig, codec: 'opus' },
    }),
    /AAC/i,
  );
  assert.throws(
    () => muxAudio({
      ...validAudio,
      decoderConfig: { ...validAudio.decoderConfig, sampleRate: 65_536 },
    }),
    /sampleRate/i,
  );
  assert.throws(
    () => muxAudio({
      ...validAudio,
      decoderConfig: { ...validAudio.decoderConfig, numberOfChannels: 0 },
    }),
    /numberOfChannels/i,
  );
  assert.throws(
    () => muxAudio({
      ...validAudio,
      decoderConfig: { ...validAudio.decoderConfig, description: new Uint8Array() },
    }),
    /description.*empty/i,
  );
  assert.throws(
    () => muxAudio({
      ...validAudio,
      samples: [{ data: new Uint8Array(), timestamp: 0, duration: 21_333 }],
    }),
    /audio\.samples\[0\].*empty/i,
  );
  assert.throws(
    () => muxAudio({
      ...validAudio,
      samples: [{ data: new Uint8Array([1]), timestamp: 1, duration: 21_333 }],
    }),
    /timestamp 0/i,
  );
  assert.throws(
    () => muxAudio({
      ...validAudio,
      samples: [{ data: new Uint8Array([1]), timestamp: 0, duration: 0 }],
    }),
    /duration/i,
  );
  assert.throws(
    () => muxAudio({
      ...validAudio,
      samples: [
        validAudio.samples[0],
        { ...validAudio.samples[1], timestamp: 21_433 },
      ],
    }),
    /contiguous/i,
  );
  assert.throws(
    () => muxAudio({
      ...validAudio,
      samples: [{ data: new Uint8Array([1]), timestamp: 0, duration: 1 }],
    }),
    /timescale tick/i,
  );
});

console.log();
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
