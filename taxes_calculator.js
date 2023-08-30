import { promises as fs } from "fs";
import { parse } from "date-fns";

// todo take it from api
const stockSplitHistory = {
  // 4-for-1 basis on August 28, 2020
  AAPL: [{
    date: new Date(2020, 7, 28),
    split: 4
  }],
  // TSLA stock last split on August 31, 2020. That was a 5-to-1 stock split
  TSLA: [{
    date: new Date(2020, 7, 31),
    split: 5
  }]
};

async function readRatesFile(file) {
  const ratesFile = await fs.readFile(file, "utf8");
  const lines = ratesFile.split("\n").slice(2);
  const rates = [];
  for (const line of lines) {
    if (line.trim().length === 0) break;
    const [dateStr, , rateStr] = line.split(";");
    // console.log({ line, rateStr })
    const rate = {
      date: parse(dateStr, "yyyyMMdd", new Date()),
      rate: Number.parseFloat(rateStr.replace(",", "."))
    };
    rates.push(rate);
  }
  return rates;
}

async function combineRates() {
  // from https://www.nbp.pl/home.aspx?f=/kursy/arch_a.html
  const rates = [
    ...await readRatesFile("archiwum_tab_a_2019.csv"),
    ...await readRatesFile("archiwum_tab_a_2020.csv"),
    ...await readRatesFile("archiwum_tab_a_2021.csv")
  ];
  return rates;
}

function findRate(rates, date) {
  let prevRate = rates[0];
  for (const rate of rates) {
    if (rate.date - date >= 0) {
      // console.log('rate found', prevRate.date.toDateString(), prevRate.rate);
      return prevRate.rate;
    }
    prevRate = rate;
  }
  return 0;
}

function parseRevolutNumber(usd) {
  return Number.parseFloat(usd.replace(",", ""));
}

function parseTransactionUsdValue(line) {
  const usd = /[+-]\$([\d.,]+)/.exec(line)?.[1];
  if (!usd) {
    console.log("no usd", line);
    throw new Error("no usd");
  }
  return parseRevolutNumber(usd);
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

function getSplitMultiplier(company, date) {
  const splits = stockSplitHistory[company]?.filter((spl) => date < spl.date) ?? [];
  if (splits.length === 0) return 1;
  const splitMultiplyer = splits.reduce((acc, split) => acc * split.split, 1);
  // console.log('splits multiply', company, date.toLocaleDateString(), shares, splitMultiplyer);
  return splitMultiplyer;
}

function parseStock(type, line, date, rate) {
  const usd = parseTransactionUsdValue(line);
  const split = line.split(" ");
  const shares = parseRevolutNumber(split[2]);
  const company = split[1];
  return {
    type,
    company,
    originalShares: shares,
    shares: shares * getSplitMultiplier(company, date),
    date,
    rate,
    line,
    usd,
    pln: round2(usd * rate)
  };
}

function parseDevidend(line, date, rate) {
  const usd = parseTransactionUsdValue(line);
  // console.log(line, ' pln=', usd * rate)
  return {
    date,
    rate,
    line,
    usd,
    pln: round2(usd * rate)
  };
}

async function parseHtmlTransactions(rates, transactions) {
  let year;
  let date;
  let rate;
  const devidends = [];
  const stocks = [];
  for (const line of transactions) {
    // const line = l.trim();
    // console.log(JSON.stringify(line));
    switch (true) {
      case /^\d{4}$/.test(line):
        year = Number.parseInt(line, 10);
        break;
      case /^\d{1,2} \w+$/.test(line):
        date = parse(`${year} ${line}`, "yyyy dd MMMM", new Date(2010, 0, 1));
        rate = findRate(rates, date);
        // console.log('rate for date', date.toDateString(), rate);
        break;
      case /^Buy /.test(line):
        // console.log('buy', date.toDateString(), line);
        stocks.push(parseStock("buy", line, date, rate));
        break;
      case /^Sell /.test(line):
        // console.log('sell', date.toDateString(), line);
        stocks.push(parseStock("sell", line, date, rate));
        break;
      case /^Dividend /.test(line):
        // console.log('Dividend', date.toDateString(), line);
        devidends.push(parseDevidend(line, date, rate));
        break;
      default:
        if (line.trim().length > 0) {
          console.log("no case for line", line);
        }
    }
  }

  return {
    devidends,
    stocks
  };
}

function calculateStocks(originalStocks) {
  const stocks = [...originalStocks].reverse();
  const buyTransactions = stocks
    .filter((x) => x.type === "buy")
    .map((t) => ({ ...t, restShares: t.shares }));
  const sellTransactions = stocks.filter((x) => x.type === "sell");
  for (const sellTransaction of sellTransactions) {
    sellTransaction.bought = [];
    // we need to find buy transaction for sold shares amount
    let sharesToFind = sellTransaction.shares;
    const buys = buyTransactions
      .filter((buyT) => buyT.company === sellTransaction.company
        && buyT.date <= sellTransaction.date);
    for (const buyTransaction of buys) {
      if (sharesToFind === 0) break;
      if (buyTransaction.restShares === 0) continue; // eslint-disable-line no-continue
      if (sharesToFind <= buyTransaction.restShares) {
        buyTransaction.restShares -= sharesToFind;
        sellTransaction.bought.push({
          ...buyTransaction,
          boughtShares: sharesToFind
        });
        sharesToFind = 0;
      } else {
        sellTransaction.bought.push({
          ...buyTransaction,
          boughtShares: buyTransaction.restShares
        });
        sharesToFind -= buyTransaction.restShares;
        buyTransaction.restShares = 0;
      }
    }
    const boughtPrice = sellTransaction.bought
      .reduce((acc, x) => acc + (x.pln * x.boughtShares) / x.shares, 0);
    sellTransaction.boughtPrice = round2(boughtPrice);
    sellTransaction.income = sellTransaction.pln - boughtPrice;
    if (Math.abs(sharesToFind) > 0.0000001) {
      console.log("cound not where shares were bought", sharesToFind, sellTransaction.date.toLocaleDateString(), sellTransaction.company);
    }
  }

  return stocks;
}

function calcDevidents(devidends, year) {
  return devidends
    .filter((d) => d.date.getFullYear() === year)
    .map((d) => d.pln)
    .reduce((acc, cur) => acc + cur, 0);
}

async function main() {
  const rates = await combineRates();
  const htmlTransactions = (await fs.readFile("stocks_transactions.txt", "utf8"))
    .split("\n");
  const transactions = await parseHtmlTransactions(rates, htmlTransactions);

  // const divedends = calcDevidents(transactions.devidends, 2021);

  const stocks = calculateStocks(transactions.stocks);
  // console.dir(stocks.filter(x => x.company === 'AAPL'), { depth: null });
  // console.dir(stocks.filter(x => x.type === 'sell' && x.date.getFullYear() === 2021));
  const income = stocks.filter((x) => x.type === "sell" && x.date.getFullYear() === 2021).reduce((acc, x) => acc + x.income, 0);
  console.log("income", income);
  console.log("taxes 19%", round2(round2(income) * 0.19));
  // eslint-disable-next-line max-len
  // console.log(stocks.filter(x => x.company === 'TSLA').map(x => x.date.toLocaleDateString() + ": " + x.line).join('\n'))
}

main();
