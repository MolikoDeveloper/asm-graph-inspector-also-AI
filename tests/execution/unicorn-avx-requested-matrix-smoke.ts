import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornEngine, UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const nasmPath = resolve('public/vendor/toolchain/nasm.3.00.elf');
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx-requested-'));

const CODE = 0x100000;
const DATA = 0x200000;
const STACK = 0x300000;
const PAGE = 4096;
const SLOT = 16;

type Case = Readonly<{ name: string; asm: string }>;

const CASES: readonly Case[] = [
  { name: 'VADDPD', asm: 'vaddpd ymm0, ymm1, ymm2' },
  { name: 'VADDPS', asm: 'vaddps ymm0, ymm1, ymm2' },
  { name: 'VADDSD', asm: 'vaddsd xmm0, xmm1, xmm2' },
  { name: 'VADDSS', asm: 'vaddss xmm0, xmm1, xmm2' },
  { name: 'VADDSUBPD', asm: 'vaddsubpd ymm0, ymm1, ymm2' },
  { name: 'VADDSUBPS', asm: 'vaddsubps ymm0, ymm1, ymm2' },
  { name: 'VANDNPD', asm: 'vandnpd ymm0, ymm1, ymm2' },
  { name: 'VANDNPS', asm: 'vandnps ymm0, ymm1, ymm2' },
  { name: 'VANDPD', asm: 'vandpd ymm0, ymm1, ymm2' },
  { name: 'VANDPS', asm: 'vandps ymm0, ymm1, ymm2' },
  { name: 'VBLENDPD', asm: 'vblendpd ymm0, ymm1, ymm2, 0x5a' },
  { name: 'VBLENDPS', asm: 'vblendps ymm0, ymm1, ymm2, 0x5a' },
  { name: 'VBLENDVPD', asm: 'vblendvpd xmm0, xmm1, xmm2, xmm3' },
  { name: 'VBLENDVPS', asm: 'vblendvps xmm0, xmm1, xmm2, xmm3' },
  { name: 'VBROADCASTF128', asm: 'vbroadcastf128 ymm0, [rax]' },
  { name: 'VBROADCASTSD', asm: 'vbroadcastsd ymm0, [rax]' },
  { name: 'VBROADCASTSS', asm: 'vbroadcastss ymm0, [rax]' },
  { name: 'VCMPPD', asm: 'vcmppd ymm0, ymm1, ymm2, 0' },
  { name: 'VCMPPS', asm: 'vcmpps ymm0, ymm1, ymm2, 0' },
  { name: 'VCMPSD', asm: 'vcmpsd xmm0, xmm1, xmm2, 0' },
  { name: 'VCMPSS', asm: 'vcmpss xmm0, xmm1, xmm2, 0' },
  { name: 'VCOMISD', asm: 'vcomisd xmm1, xmm2' },
  { name: 'VCOMISS', asm: 'vcomiss xmm1, xmm2' },
  { name: 'VCVTDQ2PD', asm: 'vcvtdq2pd ymm0, xmm1' },
  { name: 'VCVTDQ2PS', asm: 'vcvtdq2ps ymm0, ymm1' },
  { name: 'VCVTPD2DQ', asm: 'vcvtpd2dq xmm0, ymm1' },
  { name: 'VCVTPD2PS', asm: 'vcvtpd2ps xmm0, ymm1' },
  { name: 'VCVTPS2DQ', asm: 'vcvtps2dq ymm0, ymm1' },
  { name: 'VCVTPS2PD', asm: 'vcvtps2pd ymm0, xmm1' },
  { name: 'VCVTSD2SI', asm: 'vcvtsd2si rax, xmm1' },
  { name: 'VCVTSD2SS', asm: 'vcvtsd2ss xmm0, xmm1, xmm2' },
  { name: 'VCVTSI2SD', asm: 'vcvtsi2sd xmm0, xmm1, rax' },
  { name: 'VCVTSI2SS', asm: 'vcvtsi2ss xmm0, xmm1, rax' },
  { name: 'VCVTSS2SD', asm: 'vcvtss2sd xmm0, xmm1, xmm2' },
  { name: 'VCVTSS2SI', asm: 'vcvtss2si rax, xmm1' },
  { name: 'VCVTTPD2DQ', asm: 'vcvttpd2dq xmm0, ymm1' },
  { name: 'VCVTTPS2DQ', asm: 'vcvttps2dq ymm0, ymm1' },
  { name: 'VCVTTSD2SI', asm: 'vcvttsd2si rax, xmm1' },
  { name: 'VCVTTSS2SI', asm: 'vcvttss2si rax, xmm1' },
  { name: 'VDIVPD', asm: 'vdivpd ymm0, ymm1, ymm2' },
  { name: 'VDIVPS', asm: 'vdivps ymm0, ymm1, ymm2' },
  { name: 'VDIVSD', asm: 'vdivsd xmm0, xmm1, xmm2' },
  { name: 'VDIVSS', asm: 'vdivss xmm0, xmm1, xmm2' },
  { name: 'VDPPD', asm: 'vdppd xmm0, xmm1, xmm2, 0xff' },
  { name: 'VDPPS', asm: 'vdpps ymm0, ymm1, ymm2, 0xff' },
  { name: 'VEXTRACTF128', asm: 'vextractf128 xmm0, ymm1, 1' },
  { name: 'VEXTRACTPS', asm: 'vextractps eax, xmm1, 1' },
  { name: 'VHADDPD', asm: 'vhaddpd ymm0, ymm1, ymm2' },
  { name: 'VHADDPS', asm: 'vhaddps ymm0, ymm1, ymm2' },
  { name: 'VHSUBPD', asm: 'vhsubpd ymm0, ymm1, ymm2' },
  { name: 'VHSUBPS', asm: 'vhsubps ymm0, ymm1, ymm2' },
  { name: 'VINSERTF128', asm: 'vinsertf128 ymm0, ymm1, xmm2, 1' },
  { name: 'VINSERTPS', asm: 'vinsertps xmm0, xmm1, xmm2, 0x10' },
  { name: 'VLDDQU', asm: 'vlddqu ymm0, [rax]' },
  { name: 'VLDMXCSR', asm: 'vldmxcsr [rax]' },
  { name: 'VMASKMOVDQU', asm: 'vmaskmovdqu xmm1, xmm2' },
  { name: 'VMASKMOVPD', asm: 'vmaskmovpd ymm0, ymm1, [rax]' },
  { name: 'VMASKMOVPS', asm: 'vmaskmovps ymm0, ymm1, [rax]' },
  { name: 'VMAXPD', asm: 'vmaxpd ymm0, ymm1, ymm2' },
  { name: 'VMAXPS', asm: 'vmaxps ymm0, ymm1, ymm2' },
  { name: 'VMAXSD', asm: 'vmaxsd xmm0, xmm1, xmm2' },
  { name: 'VMAXSS', asm: 'vmaxss xmm0, xmm1, xmm2' },
  { name: 'VMINPD', asm: 'vminpd ymm0, ymm1, ymm2' },
  { name: 'VMINPS', asm: 'vminps ymm0, ymm1, ymm2' },
  { name: 'VMINSD', asm: 'vminsd xmm0, xmm1, xmm2' },
  { name: 'VMINSS', asm: 'vminss xmm0, xmm1, xmm2' },
  { name: 'VMOVAPD', asm: 'vmovapd ymm0, ymm1' },
  { name: 'VMOVAPS', asm: 'vmovaps ymm0, ymm1' },
  { name: 'VMOVD', asm: 'vmovd xmm0, eax' },
  { name: 'VMOVDDUP', asm: 'vmovddup ymm0, ymm1' },
  { name: 'VMOVDQA', asm: 'vmovdqa ymm0, ymm1' },
  { name: 'VMOVDQU', asm: 'vmovdqu ymm0, ymm1' },
  { name: 'VMOVHLPS', asm: 'vmovhlps xmm0, xmm1, xmm2' },
  { name: 'VMOVHPD', asm: 'vmovhpd xmm0, xmm1, [rax]' },
  { name: 'VMOVHPS', asm: 'vmovhps xmm0, xmm1, [rax]' },
  { name: 'VMOVLHPS', asm: 'vmovlhps xmm0, xmm1, xmm2' },
  { name: 'VMOVLPD', asm: 'vmovlpd xmm0, xmm1, [rax]' },
  { name: 'VMOVLPS', asm: 'vmovlps xmm0, xmm1, [rax]' },
  { name: 'VMOVMSKPD', asm: 'vmovmskpd eax, ymm1' },
  { name: 'VMOVMSKPS', asm: 'vmovmskps eax, ymm1' },
  { name: 'VMOVNTDQ', asm: 'vmovntdq [rax], ymm1' },
  { name: 'VMOVNTDQA', asm: 'vmovntdqa ymm0, [rax]' },
  { name: 'VMOVNTPD', asm: 'vmovntpd [rax], ymm1' },
  { name: 'VMOVNTPS', asm: 'vmovntps [rax], ymm1' },
  { name: 'VMOVQ', asm: 'vmovq xmm0, rax' },
  { name: 'VMOVSD', asm: 'vmovsd xmm0, xmm1, xmm2' },
  { name: 'VMOVSHDUP', asm: 'vmovshdup ymm0, ymm1' },
  { name: 'VMOVSLDUP', asm: 'vmovsldup ymm0, ymm1' },
  { name: 'VMOVSS', asm: 'vmovss xmm0, xmm1, xmm2' },
  { name: 'VMOVUPD', asm: 'vmovupd ymm0, ymm1' },
  { name: 'VMOVUPS', asm: 'vmovups ymm0, ymm1' },
  { name: 'VMPSADBW', asm: 'vmpsadbw ymm0, ymm1, ymm2, 0' },
  { name: 'VMULPD', asm: 'vmulpd ymm0, ymm1, ymm2' },
  { name: 'VMULPS', asm: 'vmulps ymm0, ymm1, ymm2' },
  { name: 'VMULSD', asm: 'vmulsd xmm0, xmm1, xmm2' },
  { name: 'VMULSS', asm: 'vmulss xmm0, xmm1, xmm2' },
  { name: 'VORPD', asm: 'vorpd ymm0, ymm1, ymm2' },
  { name: 'VORPS', asm: 'vorps ymm0, ymm1, ymm2' },
  { name: 'VPABSB', asm: 'vpabsb ymm0, ymm1' },
  { name: 'VPABSD', asm: 'vpabsd ymm0, ymm1' },
  { name: 'VPABSW', asm: 'vpabsw ymm0, ymm1' },
  { name: 'VPACKSSDW', asm: 'vpackssdw ymm0, ymm1, ymm2' },
  { name: 'VPACKSSWB', asm: 'vpacksswb ymm0, ymm1, ymm2' },
  { name: 'VPACKUSDW', asm: 'vpackusdw ymm0, ymm1, ymm2' },
  { name: 'VPACKUSWB', asm: 'vpackuswb ymm0, ymm1, ymm2' },
  { name: 'VPADDB', asm: 'vpaddb ymm0, ymm1, ymm2' },
  { name: 'VPADDD', asm: 'vpaddd ymm0, ymm1, ymm2' },
  { name: 'VPADDQ', asm: 'vpaddq ymm0, ymm1, ymm2' },
  { name: 'VPADDSB', asm: 'vpaddsb ymm0, ymm1, ymm2' },
  { name: 'VPADDSW', asm: 'vpaddsw ymm0, ymm1, ymm2' },
  { name: 'VPADDUSB', asm: 'vpaddusb ymm0, ymm1, ymm2' },
  { name: 'VPADDUSW', asm: 'vpaddusw ymm0, ymm1, ymm2' },
  { name: 'VPADDW', asm: 'vpaddw ymm0, ymm1, ymm2' },
  { name: 'VPALIGNR', asm: 'vpalignr ymm0, ymm1, ymm2, 7' },
  { name: 'VPAND', asm: 'vpand ymm0, ymm1, ymm2' },
  { name: 'VPANDN', asm: 'vpandn ymm0, ymm1, ymm2' },
  { name: 'VPAVGB', asm: 'vpavgb ymm0, ymm1, ymm2' },
  { name: 'VPAVGW', asm: 'vpavgw ymm0, ymm1, ymm2' },
  { name: 'VPBLENDVB', asm: 'vpblendvb ymm0, ymm1, ymm2, ymm3' },
  { name: 'VPBLENDW', asm: 'vpblendw ymm0, ymm1, ymm2, 0x5a' },
  { name: 'VPCMPEQB', asm: 'vpcmpeqb ymm0, ymm1, ymm2' },
  { name: 'VPCMPEQD', asm: 'vpcmpeqd ymm0, ymm1, ymm2' },
  { name: 'VPCMPEQQ', asm: 'vpcmpeqq ymm0, ymm1, ymm2' },
  { name: 'VPCMPEQW', asm: 'vpcmpeqw ymm0, ymm1, ymm2' },
  { name: 'VPCMPESTRI', asm: 'vpcmpestri xmm1, xmm2, 0' },
  { name: 'VPCMPESTRM', asm: 'vpcmpestrm xmm1, xmm2, 0' },
  { name: 'VPCMPGTB', asm: 'vpcmpgtb ymm0, ymm1, ymm2' },
  { name: 'VPCMPGTD', asm: 'vpcmpgtd ymm0, ymm1, ymm2' },
  { name: 'VPCMPGTQ', asm: 'vpcmpgtq ymm0, ymm1, ymm2' },
  { name: 'VPCMPGTW', asm: 'vpcmpgtw ymm0, ymm1, ymm2' },
  { name: 'VPCMPISTRI', asm: 'vpcmpistri xmm1, xmm2, 0' },
  { name: 'VPCMPISTRM', asm: 'vpcmpistrm xmm1, xmm2, 0' },
  { name: 'VPERM2F128', asm: 'vperm2f128 ymm0, ymm1, ymm2, 0x21' },
  { name: 'VPERMILPD', asm: 'vpermilpd ymm0, ymm1, 0x5' },
  { name: 'VPERMILPS', asm: 'vpermilps ymm0, ymm1, 0x1b' },
  { name: 'VPEXTRB', asm: 'vpextrb eax, xmm1, 1' },
  { name: 'VPEXTRD', asm: 'vpextrd eax, xmm1, 1' },
  { name: 'VPEXTRQ', asm: 'vpextrq rax, xmm1, 1' },
  { name: 'VPEXTRW', asm: 'vpextrw eax, xmm1, 1' },
  { name: 'VPHADDD', asm: 'vphaddd ymm0, ymm1, ymm2' },
  { name: 'VPHADDSW', asm: 'vphaddsw ymm0, ymm1, ymm2' },
  { name: 'VPHADDW', asm: 'vphaddw ymm0, ymm1, ymm2' },
  { name: 'VPHMINPOSUW', asm: 'vphminposuw xmm0, xmm1' },
  { name: 'VPHSUBD', asm: 'vphsubd ymm0, ymm1, ymm2' },
  { name: 'VPHSUBSW', asm: 'vphsubsw ymm0, ymm1, ymm2' },
  { name: 'VPHSUBW', asm: 'vphsubw ymm0, ymm1, ymm2' },
  { name: 'VPINSRB', asm: 'vpinsrb xmm0, xmm1, eax, 1' },
  { name: 'VPINSRD', asm: 'vpinsrd xmm0, xmm1, eax, 1' },
  { name: 'VPINSRQ', asm: 'vpinsrq xmm0, xmm1, rax, 1' },
  { name: 'VPINSRW', asm: 'vpinsrw xmm0, xmm1, eax, 1' },
  { name: 'VPMADDUBSW', asm: 'vpmaddubsw ymm0, ymm1, ymm2' },
  { name: 'VPMADDWD', asm: 'vpmaddwd ymm0, ymm1, ymm2' },
  { name: 'VPMAXSB', asm: 'vpmaxsb ymm0, ymm1, ymm2' },
  { name: 'VPMAXSD', asm: 'vpmaxsd ymm0, ymm1, ymm2' },
  { name: 'VPMAXSW', asm: 'vpmaxsw ymm0, ymm1, ymm2' },
  { name: 'VPMAXUB', asm: 'vpmaxub ymm0, ymm1, ymm2' },
  { name: 'VPMAXUD', asm: 'vpmaxud ymm0, ymm1, ymm2' },
  { name: 'VPMAXUW', asm: 'vpmaxuw ymm0, ymm1, ymm2' },
  { name: 'VPMINSB', asm: 'vpminsb ymm0, ymm1, ymm2' },
  { name: 'VPMINSD', asm: 'vpminsd ymm0, ymm1, ymm2' },
  { name: 'VPMINSW', asm: 'vpminsw ymm0, ymm1, ymm2' },
  { name: 'VPMINUB', asm: 'vpminub ymm0, ymm1, ymm2' },
  { name: 'VPMINUD', asm: 'vpminud ymm0, ymm1, ymm2' },
  { name: 'VPMINUW', asm: 'vpminuw ymm0, ymm1, ymm2' },
  { name: 'VPMOVMSKB', asm: 'vpmovmskb eax, ymm1' },
  { name: 'VPMOVSXBD', asm: 'vpmovsxbd ymm0, xmm1' },
  { name: 'VPMOVSXBQ', asm: 'vpmovsxbq ymm0, xmm1' },
  { name: 'VPMOVSXBW', asm: 'vpmovsxbw ymm0, xmm1' },
  { name: 'VPMOVSXDQ', asm: 'vpmovsxdq ymm0, xmm1' },
  { name: 'VPMOVSXWD', asm: 'vpmovsxwd ymm0, xmm1' },
  { name: 'VPMOVSXWQ', asm: 'vpmovsxwq ymm0, xmm1' },
  { name: 'VPMOVZXBD', asm: 'vpmovzxbd ymm0, xmm1' },
  { name: 'VPMOVZXBQ', asm: 'vpmovzxbq ymm0, xmm1' },
  { name: 'VPMOVZXBW', asm: 'vpmovzxbw ymm0, xmm1' },
  { name: 'VPMOVZXDQ', asm: 'vpmovzxdq ymm0, xmm1' },
  { name: 'VPMOVZXWD', asm: 'vpmovzxwd ymm0, xmm1' },
  { name: 'VPMOVZXWQ', asm: 'vpmovzxwq ymm0, xmm1' },
  { name: 'VPMULDQ', asm: 'vpmuldq ymm0, ymm1, ymm2' },
  { name: 'VPMULHRSW', asm: 'vpmulhrsw ymm0, ymm1, ymm2' },
  { name: 'VPMULHUW', asm: 'vpmulhuw ymm0, ymm1, ymm2' },
  { name: 'VPMULHW', asm: 'vpmulhw ymm0, ymm1, ymm2' },
  { name: 'VPMULLD', asm: 'vpmulld ymm0, ymm1, ymm2' },
  { name: 'VPMULLW', asm: 'vpmullw ymm0, ymm1, ymm2' },
  { name: 'VPMULUDQ', asm: 'vpmuludq ymm0, ymm1, ymm2' },
  { name: 'VPOR', asm: 'vpor ymm0, ymm1, ymm2' },
  { name: 'VPSADBW', asm: 'vpsadbw ymm0, ymm1, ymm2' },
  { name: 'VPSHUFB', asm: 'vpshufb ymm0, ymm1, ymm2' },
  { name: 'VPSHUFD', asm: 'vpshufd ymm0, ymm1, 0x1b' },
  { name: 'VPSHUFHW', asm: 'vpshufhw ymm0, ymm1, 0x1b' },
  { name: 'VPSHUFLW', asm: 'vpshuflw ymm0, ymm1, 0x1b' },
  { name: 'VPSIGNB', asm: 'vpsignb ymm0, ymm1, ymm2' },
  { name: 'VPSIGND', asm: 'vpsignd ymm0, ymm1, ymm2' },
  { name: 'VPSIGNW', asm: 'vpsignw ymm0, ymm1, ymm2' },
  { name: 'VPSLLD', asm: 'vpslld ymm0, ymm1, 4' },
  { name: 'VPSLLQ', asm: 'vpsllq ymm0, ymm1, 4' },
  { name: 'VPSLLW', asm: 'vpsllw ymm0, ymm1, 4' },
  { name: 'VPSRAD', asm: 'vpsrad ymm0, ymm1, 4' },
  { name: 'VPSRAW', asm: 'vpsraw ymm0, ymm1, 4' },
  { name: 'VPSRLD', asm: 'vpsrld ymm0, ymm1, 4' },
  { name: 'VPSRLQ', asm: 'vpsrlq ymm0, ymm1, 4' },
  { name: 'VPSRLW', asm: 'vpsrlw ymm0, ymm1, 4' },
  { name: 'VPSUBB', asm: 'vpsubb ymm0, ymm1, ymm2' },
  { name: 'VPSUBD', asm: 'vpsubd ymm0, ymm1, ymm2' },
  { name: 'VPSUBQ', asm: 'vpsubq ymm0, ymm1, ymm2' },
  { name: 'VPSUBSB', asm: 'vpsubsb ymm0, ymm1, ymm2' },
  { name: 'VPSUBSW', asm: 'vpsubsw ymm0, ymm1, ymm2' },
  { name: 'VPSUBUSB', asm: 'vpsubusb ymm0, ymm1, ymm2' },
  { name: 'VPSUBUSW', asm: 'vpsubusw ymm0, ymm1, ymm2' },
  { name: 'VPSUBW', asm: 'vpsubw ymm0, ymm1, ymm2' },
  { name: 'VPTEST', asm: 'vptest ymm1, ymm2' },
  { name: 'VPUNPCKHBW', asm: 'vpunpckhbw ymm0, ymm1, ymm2' },
  { name: 'VPUNPCKHDQ', asm: 'vpunpckhdq ymm0, ymm1, ymm2' },
  { name: 'VPUNPCKHQDQ', asm: 'vpunpckhqdq ymm0, ymm1, ymm2' },
  { name: 'VPUNPCKHWD', asm: 'vpunpckhwd ymm0, ymm1, ymm2' },
  { name: 'VPUNPCKLBW', asm: 'vpunpcklbw ymm0, ymm1, ymm2' },
  { name: 'VPUNPCKLDQ', asm: 'vpunpckldq ymm0, ymm1, ymm2' },
  { name: 'VPUNPCKLQDQ', asm: 'vpunpcklqdq ymm0, ymm1, ymm2' },
  { name: 'VPUNPCKLWD', asm: 'vpunpcklwd ymm0, ymm1, ymm2' },
  { name: 'VPXOR', asm: 'vpxor ymm0, ymm1, ymm2' },
  { name: 'VRCPPS', asm: 'vrcpps ymm0, ymm1' },
  { name: 'VRCPSS', asm: 'vrcpss xmm0, xmm1, xmm2' },
  { name: 'VROUNDPD', asm: 'vroundpd ymm0, ymm1, 0' },
  { name: 'VROUNDPS', asm: 'vroundps ymm0, ymm1, 0' },
  { name: 'VROUNDSD', asm: 'vroundsd xmm0, xmm1, xmm2, 0' },
  { name: 'VROUNDSS', asm: 'vroundss xmm0, xmm1, xmm2, 0' },
  { name: 'VRSQRTPS', asm: 'vrsqrtps ymm0, ymm1' },
  { name: 'VRSQRTSS', asm: 'vrsqrtss xmm0, xmm1, xmm2' },
  { name: 'VSHUFPD', asm: 'vshufpd ymm0, ymm1, ymm2, 0x5' },
  { name: 'VSHUFPS', asm: 'vshufps ymm0, ymm1, ymm2, 0x1b' },
  { name: 'VSQRTPD', asm: 'vsqrtpd ymm0, ymm1' },
  { name: 'VSQRTPS', asm: 'vsqrtps ymm0, ymm1' },
  { name: 'VSQRTSD', asm: 'vsqrtsd xmm0, xmm1, xmm2' },
  { name: 'VSQRTSS', asm: 'vsqrtss xmm0, xmm1, xmm2' },
  { name: 'VSTMXCSR', asm: 'vstmxcsr [rax]' },
  { name: 'VSUBPD', asm: 'vsubpd ymm0, ymm1, ymm2' },
  { name: 'VSUBPS', asm: 'vsubps ymm0, ymm1, ymm2' },
  { name: 'VSUBSD', asm: 'vsubsd xmm0, xmm1, xmm2' },
  { name: 'VSUBSS', asm: 'vsubss xmm0, xmm1, xmm2' },
  { name: 'VTESTPD', asm: 'vtestpd ymm1, ymm2' },
  { name: 'VTESTPS', asm: 'vtestps ymm1, ymm2' },
  { name: 'VUCOMISD', asm: 'vucomisd xmm1, xmm2' },
  { name: 'VUCOMISS', asm: 'vucomiss xmm1, xmm2' },
  { name: 'VUNPCKHPD', asm: 'vunpckhpd ymm0, ymm1, ymm2' },
  { name: 'VUNPCKHPS', asm: 'vunpckhps ymm0, ymm1, ymm2' },
  { name: 'VUNPCKLPD', asm: 'vunpcklpd ymm0, ymm1, ymm2' },
  { name: 'VUNPCKLPS', asm: 'vunpcklps ymm0, ymm1, ymm2' },
  { name: 'VXORPD', asm: 'vxorpd ymm0, ymm1, ymm2' },
  { name: 'VXORPS', asm: 'vxorps ymm0, ymm1, ymm2' },
  { name: 'VZEROALL', asm: 'vzeroall' },
  { name: 'VZEROUPPER', asm: 'vzeroupper' },
];

function runTool(executable: string, args: string[]): void {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed with ${result.status}:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
}

function roundPage(value: number): number {
  return Math.ceil(value / PAGE) * PAGE;
}

function writeBootstrapMemory(engine: UnicornEngine): void {
  const data = new Uint8Array(PAGE);
  // Architectural default MXCSR = 0x1f80. The same page is intentionally safe
  // as scalar/vector input for memory-source smoke forms.
  data[0] = 0x80;
  data[1] = 0x1f;
  engine.mem_write(DATA, data);
}

try {
  assert.equal(CASES.length, 250, 'requested AVX instruction matrix must stay complete');

  const asmPath = join(temp, 'requested-avx.asm');
  const binPath = join(temp, 'requested-avx.bin');
  const source = [
    'bits 64',
    'org 0',
    ...CASES.flatMap((testCase, index) => [
      `; ${index.toString().padStart(3, '0')} ${testCase.name}`,
      'align 16, db 0x90',
      testCase.asm,
    ]),
    '',
  ].join('\n');
  writeFileSync(asmPath, source);
  runTool(nasmPath, ['-f', 'bin', asmPath, '-o', binPath]);

  const code = new Uint8Array(readFileSync(binPath));
  assert.ok(code.length <= CASES.length * SLOT, `assembled matrix unexpectedly exceeds fixed slots: ${code.length} bytes`);

  const runtime = join(temp, 'unicorn_x86.cjs');
  writeFileSync(runtime, runtimeBytes);
  const factory = createRequire(import.meta.url)(runtime) as UnicornFactory;
  const module = await factory();

  const failures: string[] = [];
  for (let index = 0; index < CASES.length; index += 1) {
    const testCase = CASES[index]!;
    const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
    const start = CODE + index * SLOT;

    try {
      engine.mem_map(CODE, roundPage(Math.max(code.length, PAGE)), module.PROT_ALL);
      engine.mem_write(CODE, code);
      engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
      engine.mem_map(STACK, PAGE, module.PROT_READ | module.PROT_WRITE);
      writeBootstrapMemory(engine);
      engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
      engine.reg_write_i64(module.X86_REG_RDI, BigInt(DATA + 0x100));
      engine.reg_write_i64(module.X86_REG_RSP, BigInt(STACK + PAGE - 0x20));
      engine.emu_start(start, start + SLOT, 0, 1);
    } catch (error) {
      failures.push(`${testCase.name} :: ${testCase.asm} :: ${String(error)}`);
    } finally {
      engine.close();
    }
  }

  assert.deepEqual(failures, [], `requested AVX matrix contains unsupported/invalid forms:\n${failures.join('\n')}`);
  console.log(`Unicorn requested AVX matrix: PASS (${CASES.length} instructions assembled by pinned NASM and executed one-by-one)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
