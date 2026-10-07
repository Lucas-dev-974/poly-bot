import json, math, numpy as np, pandas as pd
from scipy.stats import binomtest
rng = np.random.default_rng(20261005)
TZ='Europe/Paris'
WD=['Lun','Mar','Mer','Jeu','Ven','Sam','Dim']

def wilson(k,n,z=1.96):
    if n==0: return (None,None)
    p=k/n; den=1+z*z/n; c=(p+z*z/(2*n))/den; h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return (round(100*(c-h),1), round(100*(c+h),1))

def bh(p):
    p=np.asarray(p); n=len(p); o=np.argsort(p); q=np.empty(n); prev=1
    for i in range(n-1,-1,-1):
        j=o[i]; prev=min(prev,p[j]*n/(i+1)); q[j]=prev
    return q

def runs(win):
    """list of (start_idx, len, is_win)"""
    out=[]; i=0; n=len(win)
    while i<n:
        j=i
        while j+1<n and win[j+1]==win[i]: j+=1
        out.append((i,j-i+1,bool(win[i]))); i=j+1
    return out

def wald_wolfowitz(win):
    n1=int(win.sum()); n2=len(win)-n1; R=len(runs(win)); n=n1+n2
    mu=2*n1*n2/n+1; var=2*n1*n2*(2*n1*n2-n)/(n*n*(n-1))
    z=(R-mu)/math.sqrt(var); from scipy.stats import norm
    return dict(runs=R, expected=round(mu,1), z=round(z,2), p_two_sided=round(2*(1-norm.cdf(abs(z))),4))

def label_bins(df):
    h=df.t.dt.hour
    df['h1']=h
    df['h2']=(h//2)*2
    df['h3']=(h//3)*3
    df['wd']=df.t.dt.weekday
    return df

def streak_fields(df):
    win=df.win.values.astype(int)
    rr=runs(win)
    df['runLen']=0; df['runId']=-1; df['posInRun']=0
    for k,(s,l,w) in enumerate(rr):
        df.iloc[s:s+l, df.columns.get_loc('runLen')]=l
        df.iloc[s:s+l, df.columns.get_loc('runId')]=k
        df.iloc[s:s+l, df.columns.get_loc('posInRun')]=np.arange(1,l+1)
    df['inWinStreak2']=(df.win==1)&(df.runLen>=2)
    df['inWinStreak4']=(df.win==1)&(df.runLen>=4)
    return df, rr

def bin_table(df, col, labels, base, rr, minn=1):
    rows=[]
    win_streak_starts=[(s,l) for s,l,w in rr if w and l>=2]
    start_bin={}
    for s,l in win_streak_starts:
        b=df.iloc[s][col]; start_bin.setdefault(b,[]).append(l)
    for b in labels:
        x=df[df[col]==b]; n=len(x); k=int(x.win.sum())
        if n==0:
            rows.append(dict(bin=b,n=0)); continue
        p=binomtest(k,n,base).pvalue
        sl=start_bin.get(b,[])
        rows.append(dict(bin=b,n=n,wins=k,wr=round(100*k/n,1),ci95=wilson(k,n),liftPP=round(100*(k/n-base),1),
            p_binom=round(p,4), pnl=round(float(x.pnl.sum()),2),
            fracTradesInWinStreak2=round(float(x.inWinStreak2.mean()),3),
            fracTradesInWinStreak4=round(float(x.inWinStreak4.mean()),3),
            winStreaksStarted=len(sl), winStreaksStartedPer10Trades=round(10*len(sl)/n,2),
            longestStreakStartedHere=max(sl) if sl else 0,
            distinctDays=int(x.t.dt.date.nunique())))
    q=bh([r['p_binom'] for r in rows if r.get('n')])
    i=0
    for r in rows:
        if r.get('n'): r['q_bh']=round(float(q[i]),4); i+=1
    return rows

def rolling3(df, base):
    rows=[]
    for s in range(24):
        hrs=[(s+i)%24 for i in range(3)]
        x=df[df.h1.isin(hrs)]; n=len(x); k=int(x.win.sum())
        rows.append(dict(window=f"{s:02d}h-{(s+3)%24:02d}h", n=n, wins=k, wr=round(100*k/n,1) if n else None,
            ci95=wilson(k,n), liftPP=round(100*(k/n-base),1) if n else None, p_binom=round(binomtest(k,n,base).pvalue,4) if n else None,
            fracTradesInWinStreak2=round(float(x.inWinStreak2.mean()),3) if n else None, pnl=round(float(x.pnl.sum()),2),
            distinctDays=int(x.t.dt.date.nunique())))
    return rows

def perm_max(df, base, B=5000):
    """Null: labels exchangeable over time. Stat: max WR over 2h, 3h-rolling bins with n>=15, and max frac-in-streak."""
    win=df.win.values.astype(int); h=df.h1.values; n=len(win)
    def stats(w):
        wrs=[];fs=[]
        rr=runs(w); inS=np.zeros(n,bool)
        for s,l,ww in rr:
            if ww and l>=2: inS[s:s+l]=True
        for s in range(24):
            m=np.isin(h,[(s+i)%24 for i in range(3)])
            if m.sum()>=15: wrs.append(w[m].mean()); fs.append(inS[m].mean())
        h1w=[]
        for s in range(24):
            m=h==s
            if m.sum()>=10: h1w.append(w[m].mean())
        return max(wrs), max(fs), max(h1w), max(l for s,l,ww in rr if ww)
    obs=stats(win); null=np.array([stats(rng.permutation(win)) for _ in range(B)])
    return dict(B=B, observed=dict(maxWR_roll3h=round(obs[0]*100,1), maxFracInStreak_roll3h=round(obs[1],3), maxWR_hour=round(obs[2]*100,1), longestWinStreak=int(obs[3])),
        p_global=dict(maxWR_roll3h=round(float((null[:,0]>=obs[0]).mean()),4), maxFracInStreak_roll3h=round(float((null[:,1]>=obs[1]).mean()),4),
                      maxWR_hour=round(float((null[:,2]>=obs[2]).mean()),4), longestWinStreak=round(float((null[:,3]>=obs[3]).mean()),4)),
        null_p95=dict(maxWR_roll3h=round(float(np.quantile(null[:,0],.95))*100,1), maxWR_hour=round(float(np.quantile(null[:,2],.95))*100,1), longestWinStreak=float(np.quantile(null[:,3],.95))))

def analyze(df, name, do_perm=True):
    df=df.sort_values('ts').reset_index(drop=True)
    df=label_bins(df); df,rr=streak_fields(df)
    n=len(df); k=int(df.win.sum()); base=k/n
    ws=[(s,l) for s,l,w in rr if w]; ls=[(s,l) for s,l,w in rr if not w]
    dist={}
    for s,l in ws: dist[l]=dist.get(l,0)+1
    top=sorted(ws,key=lambda x:-x[1])[:10]
    longest=[]
    for s,l in top:
        a=df.iloc[s]; b=df.iloc[s+l-1]
        longest.append(dict(len=l, start=a.t.strftime('%Y-%m-%d %H:%M'), end=b.t.strftime('%Y-%m-%d %H:%M'), startWeekday=WD[a.t.weekday()],
                            spanHours=round((b.ts-a.ts)/3.6e6,1), pnl=round(float(df.pnl.iloc[s:s+l].sum()),2), hoursCovered=sorted(set(df.h1.iloc[s:s+l].tolist()))))
    toplos=sorted(ls,key=lambda x:-x[1])[:5]
    longestL=[dict(len=l,start=df.iloc[s].t.strftime('%Y-%m-%d %H:%M'),end=df.iloc[s+l-1].t.strftime('%Y-%m-%d %H:%M')) for s,l in toplos]
    res=dict(name=name, n=n, wins=k, losses=n-k, baselineWR=round(100*base,2), baselineCI95=wilson(k,n),
        period=dict(first=df.t.iloc[0].strftime('%Y-%m-%d %H:%M %Z'), last=df.t.iloc[-1].strftime('%Y-%m-%d %H:%M %Z'), distinctDays=int(df.t.dt.date.nunique())),
        pnl=round(float(df.pnl.sum()),2),
        runsTest=wald_wolfowitz(df.win.values.astype(int)),
        winStreaks=dict(count_len_ge2=sum(1 for s,l in ws if l>=2), count_len_ge3=sum(1 for s,l in ws if l>=3), count_len_ge5=sum(1 for s,l in ws if l>=5),
                        meanWinRunLen=round(float(np.mean([l for s,l in ws])),2), expectedMeanWinRunLenIID=round(1/(1-base),2),
                        lengthDistribution={str(k2):v for k2,v in sorted(dist.items())}, longest=longest),
        lossStreaks=dict(longest=longestL, meanLossRunLen=round(float(np.mean([l for s,l in ls])),2), expectedIID=round(1/base,2)),
        byHour=bin_table(df,'h1',range(24),base,rr),
        by2h=bin_table(df,'h2',range(0,24,2),base,rr),
        by3h=bin_table(df,'h3',range(0,24,3),base,rr),
        byWeekday=bin_table(df,'wd',range(7),base,rr),
        rolling3h=rolling3(df,base))
    for r in res['byWeekday']: r['bin']=WD[r['bin']]
    for key in ('byHour','by2h','by3h'):
        w={'byHour':1,'by2h':2,'by3h':3}[key]
        for r in res[key]: r['bin']=f"{r['bin']:02d}h-{(r['bin']+w)%24:02d}h"
    if do_perm: res['permutation']=perm_max(df,base)
    return res, df

def load_sim():
    d=pd.DataFrame(json.load(open('raw-sim-positions-fav-band.json')))
    d=d[(d.orderType=='FOK')&(d.fillReason=='marketable')]
    d['ts']=d.createdAt
    d['t']=pd.to_datetime(d.ts,unit='ms',utc=True).dt.tz_convert(TZ)
    d['win']=(d.pnl>0).astype(int)
    d['market']=np.where(d.eventSlug.str.startswith('btc-updown-15m'),'15m','5m')
    return d

out={}
sim=load_sim()
s15=sim[sim.market=='15m'].copy()
out['primary_sim_15m'],dfp=analyze(s15,'sim_positions fav-band, btc-updown-15m, FOK entries')
out['sensitivity_sim_all'],_=analyze(sim.copy(),'sim_positions fav-band, 15m+5m, FOK entries',do_perm=False)
# per-day check for top rolling windows (primary)
def per_day(df, hours):
    x=df[df.h1.isin(hours)]
    g=x.groupby(x.t.dt.date).win.agg(['size','sum'])
    return [dict(day=str(i),n=int(r['size']),wins=int(r['sum'])) for i,r in g.iterrows()]
out['primary_sim_15m']['perDayTopWindows']={}
roll=sorted([r for r in out['primary_sim_15m']['rolling3h'] if r['n']>=15], key=lambda r:-r['wr'])[:4]
for r in roll:
    s=int(r['window'][:2]); out['primary_sim_15m']['perDayTopWindows'][r['window']]=per_day(dfp,[(s+i)%24 for i in range(3)])
# split-half stability: hour-of-day WR in sizing regime 1 (<=Sep30, 5 shares) vs regime 2 (>=Oct1, $15)
cut=pd.Timestamp('2026-10-01',tz=TZ)
a=dfp[dfp.t<cut]; b=dfp[dfp.t>=cut]
stab=[]
for s in range(0,24,3):
    hrs=[s,s+1,s+2]; xa=a[a.h1.isin(hrs)]; xb=b[b.h1.isin(hrs)]
    stab.append(dict(bin=f"{s:02d}h-{s+3:02d}h", n_before=len(xa), wr_before=round(100*xa.win.mean(),1) if len(xa) else None, n_after=len(xb), wr_after=round(100*xb.win.mean(),1) if len(xb) else None))
from scipy.stats import spearmanr
va=[r['wr_before'] for r in stab]; vb=[r['wr_after'] for r in stab]
out['primary_sim_15m']['splitStability3h']=dict(cut='2026-10-01 00:00 Paris (sizing 5 sh -> 15 USDC)', bins=stab, spearman=round(float(spearmanr(va,vb).correlation),3), spearman_p=round(float(spearmanr(va,vb).pvalue),3))

# secondary: backtest run 259af8b2 fav legs
bt=pd.DataFrame(json.load(open('raw-backtest-positions-fav-band.json')))
bt=bt[(bt.runId=='259af8b2-1bd0-4285-ab42-fb5b6fb00ee0')&(bt.fillPrice>=0.70)&(bt.fillPrice<=0.85)].copy()
bt['t']=pd.to_datetime(bt.ts,unit='ms',utc=True).dt.tz_convert(TZ); bt['win']=(bt.pnl>0).astype(int)
out['secondary_backtest_259af8b2'],_=analyze(bt,'backtest_positions run 259af8b2 (preset fav-band ask 0.70-0.85, exit enabled), fav legs fill 0.70-0.85',do_perm=True)

dfp[['id','eventSlug','outcome','fillPrice','size','cost','status','pnl','win','runLen','posInRun','inWinStreak2']].assign(entryParis=dfp.t.dt.strftime('%Y-%m-%d %H:%M:%S'), weekday=dfp.wd.map(lambda i:WD[i]), hour=dfp.h1).to_csv('series-sim-15m.csv',index=False)
json.dump(out,open('streaks-time-windows-2026-10-05.raw.json','w'),indent=1,default=str)
print('ok')

# ---- focus checks on flagged hours ----
from scipy.stats import binomtest as _bt
focus={}
def perday_hour(df,h):
    x=df[df.h1==h]; g=x.groupby(x.t.dt.date).win.agg(['size','sum'])
    return [dict(day=str(i),n=int(r['size']),wins=int(r['sum'])) for i,r in g.iterrows()]
bt2=bt.sort_values('ts').reset_index(drop=True); bt2=label_bins(bt2)
for h in (2,23):
    focus[f"{h:02d}h"]=dict(sim_perDay=perday_hour(dfp,h), backtest_perDay=perday_hour(bt2,h))
# global permutation for MIN hourly WR (anti-window), primary
win=dfp.win.values; hh=dfp.h1.values
def minwr(w): return min(w[hh==s].mean() for s in range(24) if (hh==s).sum()>=10)
obs=minwr(win); null=np.array([minwr(rng.permutation(win)) for _ in range(5000)])
focus['perm_minHourWR_primary']=dict(observed=round(obs*100,1), p_global=round(float((null<=obs).mean()),4), null_p05=round(float(np.quantile(null,.05))*100,1))
# replication test in backtest for 02h (pre-specified from sim): one-sided lower
x=bt2[bt2.h1==2]; b0=bt2.win.mean()
focus['replication_02h_backtest']=dict(n=len(x),wins=int(x.win.sum()),wr=round(100*x.win.mean(),1),baseline=round(100*b0,1),p_one_sided_lower=round(_bt(int(x.win.sum()),len(x),b0,alternative='less').pvalue,4))
x=bt2[bt2.h1==23]
focus['replication_23h_backtest']=dict(n=len(x),wins=int(x.win.sum()),wr=round(100*x.win.mean(),1),baseline=round(100*b0,1),p_one_sided_greater=round(_bt(int(x.win.sum()),len(x),b0,alternative='greater').pvalue,4))
# loss streaks starting 02h
out['focus']=focus
json.dump(out,open('streaks-time-windows-2026-10-05.raw.json','w'),indent=1,default=str)
print(json.dumps(focus,indent=0))
