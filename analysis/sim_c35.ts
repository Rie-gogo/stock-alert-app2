import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, number> = {
  "8035": 0.5, "6857": 0.6, "6976": 0.6, "6526": 0.9, "5803": 0.5,
  "6981": 0.4, "285A": 0.8, "6146": 0.8, "6594": 0.5, "8316": 0.5,
};
const ACTIVE = new Set(Object.keys(SL_MAP));
const MA=20;
interface C { t:string; o:number; h:number; l:number; c:number; v:number; }
function ma(c:C[],p:number,i:number){if(i<p-1)return 0;let s=0;for(let k=i-p+1;k<=i;k++)s+=c[k].c;return s/p;}
function bull(c:C[],i:number){if(i<MA+1)return false;const cur=ma(c,MA,i),prev=ma(c,MA,i-1);return(cur-prev)/prev*100>0;}
function board(c:C[],i:number){if(i<5)return"neutral";let u=0;for(let k=i-4;k<=i;k++)if(c[k].c>c[k].o)u++;return u>=4?"buy_pressure":u<=1?"sell_pressure":"neutral";}
function sim(c:C[],ei:number,sl:number){const ep=c[ei].c;const sh=Math.floor(3000000/ep/100)*100||100;const slL=ep*(1-sl/100),tpL=ep*(1+TP_PCT/100);for(let j=ei+1;j<c.length;j++){if(c[j].l<=slL)return{pnl:Math.round((slL-ep)*sh),r:"SL"};if(c[j].h>=tpL)return{pnl:Math.round((tpL-ep)*sh),r:"TP"};}return{pnl:Math.round((c[c.length-1].c-ep)*sh),r:"EOD"};}

async function main(){
  const conn=await mysql.createConnection(DATABASE_URL);
  const[rows]=await conn.query(`SELECT symbol,tradeDate,candleTime,open,high,low,close,volume FROM rt_candles WHERE tradeDate>='2026-07-14' ORDER BY symbol,tradeDate,candleTime`)as any[];
  const byDS:Record<string,Record<string,C[]>>={};
  for(const r of rows){if(!ACTIVE.has(r.symbol))continue;const d=r.tradeDate;if(!byDS[d])byDS[d]={};if(!byDS[d][r.symbol])byDS[d][r.symbol]=[];byDS[d][r.symbol].push({t:r.candleTime,o:+r.open,h:+r.high,l:+r.low,c:+r.close,v:+r.volume||0});}
  await conn.end();

  type R={w:number;l:number;pnl:number;n:number};
  const res:Record<string,R>={base:{w:0,l:0,pnl:0,n:0},c3:{w:0,l:0,pnl:0,n:0},c5:{w:0,l:0,pnl:0,n:0},c35:{w:0,l:0,pnl:0,n:0}};

  for(const[,syms]of Object.entries(byDS)){
    for(const[sym,candles]of Object.entries(syms)){
      if(candles.length<30)continue;
      const sl=SL_MAP[sym];
      const used=new Set<string>();
      for(let i=25;i<candles.length-10;i++){
        if(candles[i].t<"09:05"||candles[i].t>"14:30")continue;
        let pH=0;for(let k=i-20;k<i;k++)pH=Math.max(pH,candles[k].h);
        if(!(candles[i].h>pH&&candles[i-1].h<=pH))continue;
        const sk=`${sym}-${Math.floor(i/10)}`;if(used.has(sk))continue;used.add(sk);
        const ei=i+1;if(ei>=candles.length-5)continue;
        if(!bull(candles,ei))continue;
        if(board(candles,ei)==="buy_pressure")continue;

        const t=sim(candles,ei,sl);const w=t.pnl>0;
        const ma20=ma(candles,MA,ei);
        const closeAbove=candles[ei].c>ma20;
        const pb=ei>=2&&(candles[ei-1].c<candles[ei-1].o||candles[ei-2].c<candles[ei-2].o)&&candles[ei].c>candles[ei].o;

        res.base.n++;if(w)res.base.w++;else res.base.l++;res.base.pnl+=t.pnl;
        if(pb){res.c3.n++;if(w)res.c3.w++;else res.c3.l++;res.c3.pnl+=t.pnl;}
        if(closeAbove){res.c5.n++;if(w)res.c5.w++;else res.c5.l++;res.c5.pnl+=t.pnl;}
        if(pb&&closeAbove){res.c35.n++;if(w)res.c35.w++;else res.c35.l++;res.c35.pnl+=t.pnl;}
      }
    }
  }

  console.log("=== 案3+5組み合わせシミュレーション ===");
  console.log("期間: 7/14〜8/17 | ベース: isBullish + buy_pressureブロック\n");
  console.log("| 案 | 取引数 | 勝率 | 総損益 | 1件平均 |");
  console.log("|---|---|---|---|---|");
  for(const[k,r]of Object.entries(res)){
    if(r.n===0)continue;
    const wr=(r.w/r.n*100).toFixed(1);
    const avg=Math.round(r.pnl/r.n);
    const label:Record<string,string>={base:"ベース",c3:"案3:押し目確認後",c5:"案5:close>MA20",c35:"案3+5:押し目+close>MA20"};
    console.log(`| ${label[k]} | ${r.n}件 ${r.w}勝${r.l}敗 | ${wr}% | ${r.pnl>=0?"+":""}${r.pnl.toLocaleString()}円 | ${avg>=0?"+":""}${avg.toLocaleString()}円 |`);
  }
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
