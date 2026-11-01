import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import express from 'express';
import pool from '../src/infra/db/postgres.js';
import { createContactIntelligenceRouter } from '../src/interfaces/http/routes/contactIntelligenceRoutes.js';

if (process.env.POSTGRES_DB !== 'contact_test') throw new Error('Isolated contact_test database required');
const token='a'.repeat(64), otherToken='b'.repeat(64), tenant=randomUUID(), other=randomUUID(), chat=randomUUID();
let server;
const check=(ok,label)=>{assert.ok(ok,label);console.log('PASS: '+label);};
try {
  await pool.query(`CREATE TABLE tenants(id UUID PRIMARY KEY,name TEXT,status TEXT);
    CREATE TABLE chats(id UUID PRIMARY KEY,tenant_id UUID,status TEXT,remote_number TEXT);
    CREATE TABLE chat_messages(id UUID DEFAULT gen_random_uuid(),tenant_id UUID,chat_id UUID,direction TEXT,
      status TEXT,timestamp TIMESTAMPTZ DEFAULT clock_timestamp(),created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      remote_number TEXT,connection_id TEXT,whatsapp_session_name TEXT,whatsapp_message_id TEXT,message_type TEXT)
      PARTITION BY RANGE(created_at);
    CREATE TABLE chat_messages_default PARTITION OF chat_messages DEFAULT;`);
  await pool.query(await readFile(new URL('../migrations/063_contact_intelligence.sql',import.meta.url),'utf8'));
  await pool.query("INSERT INTO tenants VALUES($1,'test','active'),($2,'other','active')",[tenant,other]);
  await pool.query("INSERT INTO chats VALUES($1,$2,'OPEN','525512345678')",[chat,tenant]);
  const activate=()=>spawnSync(process.execPath,['scripts/contactIntelligence.js',tenant],{input:token,encoding:'utf8',env:process.env});
  const installed=activate();assert.equal(installed.status,0,installed.stderr);
  const initial=(await pool.query('SELECT * FROM contact_intelligence_sources WHERE tenant_id=$1',[tenant])).rows[0];
  check(initial.last_sequence==='1','Activation takes a state baseline, without importing old messages');
  assert.equal(activate().status,0);
  check((await pool.query('SELECT * FROM contact_intelligence_sources WHERE tenant_id=$1',[tenant])).rows[0].activated_at.getTime()===initial.activated_at.getTime(),'Token installation preserves activation and history');
  await pool.query('INSERT INTO contact_intelligence_sources(tenant_id,activated_at,token_hash) VALUES($1,clock_timestamp(),$2)',[other,createHash('sha256').update(otherToken).digest('hex')]);
  const insert=async(id,direction='out',status='server',when=null)=>pool.query(`INSERT INTO chat_messages(tenant_id,chat_id,direction,status,timestamp,remote_number,
    connection_id,whatsapp_message_id,message_type) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,clock_timestamp()),'525512345678','connection',$6,'text') RETURNING timestamp`,[tenant,chat,direction,status,when,id]);
  await insert('sent-1');await insert('sent-2');await insert('incoming','in','received');await insert('failed','out','error');await insert('draft','out','pending');
  await insert('old-history','out','server',new Date(initial.activated_at.getTime()-10000));
  await insert('sent-1'); // Duplicate physical copy / device resynchronization.
  const pending=await insert('pending-ack','out','pending');
  await pool.query("UPDATE chats SET status='CLOSED' WHERE id=$1",[chat]);
  await insert('closed-send');
  await pool.query("UPDATE chat_messages SET status='delivered' WHERE whatsapp_message_id='pending-ack'");
  await pool.query("UPDATE chat_messages SET status='read' WHERE whatsapp_message_id='sent-1'");
  let sent=(await pool.query("SELECT * FROM contact_intelligence_events WHERE kind='sent' ORDER BY sequence")).rows;
  check(sent.length===3,'Only sent messages in an open conversation; no inbound, pending, failed, old history or duplicates');
  check(sent.at(-1).occurred_at.getTime()===pending.rows[0].timestamp.getTime(),'A late acknowledgement after closing retains the original sending time');
  await pool.query("UPDATE chats SET status='OPEN' WHERE id=$1",[chat]);
  await insert('reopened-send');
  const app=express();app.use(createContactIntelligenceRouter(pool));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port+'/events';
  const get=(query='',auth=token)=>fetch(base+query,{headers:auth?{authorization:'Bearer '+auth}:{}});
  check((await get('',null)).status===401&&(await get('','c'.repeat(64))).status===401,'Missing or incorrect machine token is rejected');
  check((await fetch(base,{method:'POST',headers:{authorization:'Bearer '+token}})).status===404,'Read credential exposes no send or mutation route');
  check((await get('?after=99999')).status===422&&(await get('?limit=1001')).status===422&&(await get('?after=-1')).status===422,'Invalid cursors and oversized pages are rejected');
  const otherPage=await(await get('',otherToken)).json();check(otherPage.data.events.length===0,'A second tenant cannot read the first tenant events');
  let cursor='0',all=[];
  do {const page=await(await get('?limit=2&after='+cursor)).json();all.push(...page.data.events);cursor=page.data.next_cursor;if(!page.data.has_more)break;}while(true);
  check(all.length===7&&all.every((e,i)=>e.sequence===String(i+1)),'All pages are contiguous and include close/reopen history');
  check(all.every(e=>!('content'in e)&&/^\d{4}-.+\.\d{6}Z$/.test(e.occurred_at)),'API sends metadata only, retaining UTC microseconds');
  // An uncommitted sequence cannot be overtaken by another writer or exposed to the consumer.
  const writer=await pool.connect(), nextWriter=await pool.connect();
  await writer.query('BEGIN');
  await writer.query("SELECT contact_intelligence_append($1,'state',$2,'525512345678','OPEN',clock_timestamp())",[tenant,chat]);
  let completed=false;
  const waiting=nextWriter.query("SELECT contact_intelligence_append($1,'state',$2,'525512345678','CLOSED',clock_timestamp())",[tenant,chat]).then(()=>{completed=true;});
  await new Promise(resolve=>setTimeout(resolve,100));
  const during=await(await get('?after='+cursor)).json();
  check(!completed&&during.data.events.length===0,'Concurrent capture waits; the feed never advances beyond uncommitted events');
  await writer.query('COMMIT');await waiting;writer.release();nextWriter.release();
  const after=await(await get('?after='+cursor)).json();
  check(after.data.events.length===2&&after.data.events[0].sequence===String(Number(cursor)+1),'Committed concurrent events are both recovered');
  await pool.query('DELETE FROM chats WHERE id=$1',[chat]);
  check((await pool.query("SELECT state FROM contact_intelligence_events WHERE kind='state' ORDER BY sequence DESC LIMIT 1")).rows[0].state==='REMOVED','Deleting a chat preserves its prior states and sends');
  console.log('PASS: WhatsSuite contact integration SQL, API, tenant isolation and cursor concurrency.');
} finally {if(server)await new Promise(resolve=>server.close(resolve));await pool.end();}
