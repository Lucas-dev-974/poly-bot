import json,pandas as pd
d=pd.read_csv('series-sim-15m.csv')
d['t']=pd.to_datetime(d.entryParis)
rows=[]
seen=set()
for i,r in d.iterrows():
    if r.win==1 and r.posInRun==1 and r.runLen>=5:
        seg=d.iloc[i:i+r.runLen]
        rows.append(dict(len=int(r.runLen),start=seg.entryParis.iloc[0][:16],end=seg.entryParis.iloc[-1][:16],weekday=seg.weekday.iloc[0],startHour=int(seg.hour.iloc[0]),pnl=round(seg.pnl.sum(),2)))
s=pd.DataFrame(rows)
print(s.to_string())
print(s.startHour.value_counts().sort_index().to_dict())
# hours covered by trades in streaks>=5 vs all trades
d['in5']=(d.win==1)&(d.runLen>=5)
g=d.groupby('hour').agg(n=('win','size'),in5=('in5','mean')).round(3)
print(g.T.to_string())
json.dump(rows,open('streaks5.json','w'))
