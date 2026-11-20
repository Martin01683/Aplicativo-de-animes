import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectActiveSubtitleEvents,
  cueToAssText,
  decodeSubtitleBuffer,
  hexToRgb,
  parseAssEventRuns,
  parseSubtitleContent,
} from './subtitleParser.ts';

test('decodeSubtitleBuffer handles UTF-8 BOM, UTF-16LE, and Windows-1252', () => {
  const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x4f, 0x6c, 0xc3, 0xa1]);
  assert.equal(decodeSubtitleBuffer(utf8Bom), 'Olá');

  const utf16le = new Uint8Array([0xff, 0xfe, 0x4f, 0x00, 0x69, 0x00]);
  assert.equal(decodeSubtitleBuffer(utf16le), 'Oi');

  // Windows-1252 "Ação" (0xE7 = ç, 0xE3 = ã)
  const win1252 = new Uint8Array([0x41, 0xe7, 0xe3, 0x6f]);
  assert.equal(decodeSubtitleBuffer(win1252), 'Ação');
});

test('hexToRgb converts valid 6-digit hex and rejects malformed values', () => {
  assert.deepEqual(hexToRgb('#ffff00'), [255, 255, 0]);
  assert.deepEqual(hexToRgb('#00FFAA'), [0, 255, 170]);
  assert.equal(hexToRgb('#fff'), null);
});

test('cueToAssText converts HTML tags, entities, and VTT alignment settings', () => {
  const ass = cueToAssText('<i>Olá</i> &amp; <b>Mundo</b>\nLinha 2', 'align:start line:5%');
  assert.match(ass, /^\{\\an7\}/);
  assert.ok(ass.includes('{\\i1}Olá{\\i} & {\\b1}Mundo{\\b}\\NLinha 2'));
});

test('parseSubtitleContent parses SRT cues and collects active events at timestamp', () => {
  const srt = `1
00:00:01,000 --> 00:00:04,500
Primeira fala

2
00:00:03,000 --> 00:00:06,000
Segunda fala
`;
  const script = parseSubtitleContent(srt, [255, 255, 0]);
  assert.ok(script);
  assert.equal(script.kind, 'text');
  assert.equal(script.events.length, 2);

  assert.equal(collectActiveSubtitleEvents(script, 0.5).length, 0);
  assert.equal(collectActiveSubtitleEvents(script, 2.0).length, 1);
  assert.equal(collectActiveSubtitleEvents(script, 3.5).length, 2);
});

test('parseSubtitleContent parses WebVTT with cue settings', () => {
  const vtt = `WEBVTT

00:01.000 --> 00:05.000 align:end line:10%
Texto no topo direito
`;
  const script = parseSubtitleContent(vtt, [255, 255, 255]);
  assert.ok(script);
  assert.equal(script.events.length, 1);
  const display = parseAssEventRuns(script, script.events[0]);
  assert.equal(display.align, 9);
  assert.equal(display.runs[0].text, 'Texto no topo direito');
});

test('parseSubtitleContent parses ASS Script Info, Styles, and Dialogue override tags', () => {
  const ass = `[Script Info]
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,54,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:02.00,0:00:06.00,Default,,0,0,0,,{\\an8\\pos(960,120)\\fad(200,200)}Título {\\i1}em itálico{\\i0}
`;
  const script = parseSubtitleContent(ass);
  assert.ok(script);
  assert.equal(script.kind, 'ass');
  assert.equal(script.resX, 1920);
  assert.equal(script.resY, 1080);
  assert.equal(script.events.length, 1);

  const display = parseAssEventRuns(script, script.events[0]);
  assert.equal(display.align, 8);
  assert.deepEqual(display.pos, [960, 120]);
  assert.deepEqual(display.fad, [200, 200]);
  assert.equal(display.runs[0].bold, true);
  assert.equal(display.runs[1].italic, true);
  assert.equal(display.runs[1].text, 'em itálico');
});
