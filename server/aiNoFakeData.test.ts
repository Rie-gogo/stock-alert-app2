import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 回帰テスト：AIアドバイザー（クライアント）と aiAnalysis ルーター（サーバー）が
 * 架空の板情報・歩み値を AI へ送信していないことを静的解析で検証する。
 *
 * 「コードを変えたらこのテストが落ちる」状態を作ることで、
 * 将来「うっかり架空データ送信を復活させてしまう」事故を防ぐ。
 */

const ROOT = resolve(__dirname, '..');

function readFile(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}

describe('架空データ非送信の回帰テスト', () => {
  describe('AIAdvisorPanel.tsx (クライアント)', () => {
    const src = readFile('client/src/components/AIAdvisorPanel.tsx');

    it('analyzeMarket への board は明示的に null を送信している', () => {
      // "board: null" がコードに含まれること
      expect(src).toMatch(/board:\s*null/);
    });

    it('analyzeMarket への trades は明示的に null を送信している', () => {
      expect(src).toMatch(/trades:\s*null/);
    });

    it('marketState.board や ms.board をAI送信ペイロードに渡していない', () => {
      // analyzeMarket.mutate({...}) のペイロード内に「board: ms.board」「board: marketState.board」のような参照がないこと
      expect(src).not.toMatch(/board:\s*ms\.board/);
      expect(src).not.toMatch(/board:\s*marketState\.board/);
      expect(src).not.toMatch(/trades:\s*ms\.trades/);
      expect(src).not.toMatch(/trades:\s*marketState\.trades/);
    });
  });

  describe('server/routers/aiAnalysis.ts (サーバー)', () => {
    const src = readFile('server/routers/aiAnalysis.ts');

    it('プロンプトに boardText / tradesText を含めていない', () => {
      // formatBoardForLLM / formatTradesForLLM の呼び出しがないこと
      expect(src).not.toMatch(/formatBoardForLLM\(/);
      expect(src).not.toMatch(/formatTradesForLLM\(/);
    });

    it('userPrompt に input.board / input.trades を埋め込んでいない', () => {
      expect(src).not.toMatch(/\$\{[^}]*input\.board[^}]*\}/);
      expect(src).not.toMatch(/\$\{[^}]*input\.trades[^}]*\}/);
    });

    it('プロンプトに「板情報・歩み値は使用しない」旨が明記されている', () => {
      // 透明性のため、AIが自身でも「板情報は使わない」と理解できるようプロンプトに含めている
      expect(src).toMatch(/板情報.*取得できず|板情報.*シミュレーション|板情報.*使用しない/);
    });

    it('実出来高（量・volume）は依然として AI に送信している', () => {
      // candleText の中で量を出力していること
      expect(src).toMatch(/量\$\{c\.volume/);
    });
  });

  describe('client/src/lib/advisor.ts (ルールベース診断)', () => {
    const src = readFile('client/src/lib/advisor.ts');

    it('diagnoseMarket は board の totalAskVolume / totalBidVolume を判定に使っていない', () => {
      // パラメータとして受け取っていてもロジック内で参照していなければ可
      // ここでは「totalAskVolume」「totalBidVolume」の文字列がコード本体に出現しないことを確認
      const hasUsage =
        /totalAskVolume\s*[><=!+\-*/&|]/.test(src) ||
        /totalBidVolume\s*[><=!+\-*/&|]/.test(src);
      expect(hasUsage).toBe(false);
    });

    it('歩み値（trades）配列の length や filter を判定に使っていない', () => {
      // trades.filter / trades.length / trades.reduce などの架空データ依存ロジックが残っていないこと
      expect(src).not.toMatch(/trades\.filter\(/);
      expect(src).not.toMatch(/trades\.reduce\(/);
      // trades.length はパラメータの早期 return ガード以外で使われていないことを保証
      const tradesLengthMatches = src.match(/trades\.length/g) ?? [];
      expect(tradesLengthMatches.length).toBeLessThanOrEqual(1);
    });
  });
});
