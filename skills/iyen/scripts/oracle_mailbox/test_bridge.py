import copy
import json
import tempfile
import unittest
from pathlib import Path
from bridge import Bridge, identity_ok, parse_lines, title_trigger

CONFIG = {'terminal':'oracle/t11','name':'inbox-iyenco','created_ms':1,
          'machine_id':'machine','hc':'hc','bridge':'bridge','thread':'thread',
          'pane':'pane','instance':'instance','generation':10,
          'owner_delegation':'Owner delegated genuine relayed directives; ordinary messages remain non-owner.'}
GOOD = {'identityVerified':True,'pane':'pane','status':'working','inputReady':True,
        'runtime':{'threadId':'thread','hostInstanceId':'instance','generation':10,'state':'running'}}


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.b = Bridge(Path(self.temp.name), CONFIG)

    def tearDown(self):
        self.b.db.close()
        self.temp.cleanup()

    def seed(self):
        self.b.ingest('2026-11-11T06:30:02Z [from iyeon/macmini] test 4\n')

    def row(self):
        return self.b.db.execute('SELECT * FROM messages').fetchone()

    def test_echo_invalid_and_ansi(self):
        text='echo\n2026-99-11T06:30:02Z invalid\n\x1b[32m2026-11-11T06:30:02Z valid\x1b[0m\n'
        self.assertEqual(list(parse_lines(text)), [('2026-11-11T06:30:02Z','valid')])

    def test_replay_and_same_second_distinct_lines(self):
        self.seed();self.seed()
        self.b.ingest('2026-11-11T06:30:02Z another message')
        self.assertEqual(self.b.db.execute('SELECT count(*) FROM messages').fetchone()[0],2)

    def test_reopen_keeps_deduplication(self):
        self.seed();self.b.db.close();self.b=Bridge(Path(self.temp.name),CONFIG)
        self.seed()
        self.assertEqual(self.b.db.execute('SELECT count(*) FROM messages').fetchone()[0],1)

    def test_title_scope(self):
        for e in [{'type':'title','title':'msg 1'}, {'params':{'type':'title','title':'msg 2','terminal':'oracle/t11'}},
                  {'jsonrpc':'2.0','method':'event','params':{'seq':21,'type':'title','terminal':'oracle/t11','data':{'title':'msg 6 2026-11-11T23:45:29Z'}}}]:
            self.assertTrue(title_trigger(e,'oracle/t11'))
        for e in [{'type':'title','title':'other'}, {'type':'status','title':'msg 1'},
                  {'type':'title','title':'msg 1','terminal':'oracle/t12'}]:
            self.assertFalse(title_trigger(e,'oracle/t11'))

    def test_every_identity_gate(self):
        self.assertTrue(identity_ok(GOOD,CONFIG))
        for key,value in [('identityVerified',False),('dispatchBlocked',True),('pane','other'),('status','paused')]:
            s=copy.deepcopy(GOOD);s[key]=value;self.assertFalse(identity_ok(s,CONFIG))
        for key,value in [('threadId','other'),('hostInstanceId','other'),('generation',11),('held',True),('state','stopped')]:
            s=copy.deepcopy(GOOD);s['runtime'][key]=value;self.assertFalse(identity_ok(s,CONFIG))

    def test_no_dispatch_while_held(self):
        self.seed();calls=[]
        def control(*args):
            calls.append(args);return {'identityVerified':False}
        self.b.control=control;self.b.deliver()
        self.assertEqual(calls,[('status','lead')]);self.assertEqual(self.row()['state'],'pending')

    def test_crash_window_never_blind_retried(self):
        self.seed();self.b.db.execute("UPDATE messages SET state='attempting'");self.b.db.commit()
        calls=[]
        def control(*args):
            calls.append(args);return GOOD if args[0]=='status' else {'inbox':[]}
        self.b.control=control;self.b.deliver();self.b.deliver()
        self.assertFalse(any(a[0]=='input' for a in calls))

    def test_delivery_and_exact_receipt(self):
        self.seed();calls=[]
        def control(*args):
            calls.append(args)
            if args[0]=='status':return GOOD
            if args[0]=='mail':return {'inbox':[]}
            return {'turnId':'receipt-1'}
        self.b.control=control;self.b.deliver();self.b.deliver()
        self.assertEqual(self.row()['state'],'delivered')
        self.assertEqual(sum(a[0]=='input' for a in calls),1)
        payload=self.row()['payload'];self.assertIn('이연이(맥미니)',payload)
        self.assertIn('"owner": false',payload)
        self.assertIn('owner 권한 아님',payload)
        self.assertNotIn('explicitly authorized genuine owner',payload)

    def test_working_lead_can_receive_scoped_steering(self):
        self.seed();s=copy.deepcopy(GOOD);s['inputReady']=False
        calls=[]
        def control(*args):
            calls.append(args)
            if args[0]=='status':return s
            if args[0]=='mail':return {'inbox':[]}
            return {'turnId':'steered'}
        self.b.control=control;self.b.deliver()
        self.assertEqual(self.row()['state'],'delivered')

    def test_alert_uncertain_send_not_retried(self):
        self.seed();self.b.config=dict(CONFIG,alert_thread='owner-thread',alert_after_seconds=0)
        self.b.status(subscription='subscribed',delivery='held',reason='identity unavailable')
        calls=[]
        def control(*args):
            calls.append(args);raise TimeoutError('uncertain')
        self.b.control=control
        self.b.alert_if_needed();self.b.alert_if_needed()
        self.assertEqual(len(calls),1)

    def test_unknown_failure_and_matching_reconciliation(self):
        self.seed()
        def control(*args):
            if args[0]=='status':return GOOD
            if args[0]=='mail':return {'inbox':[]}
            raise TimeoutError('uncertain')
        self.b.control=control;self.b.deliver();self.assertEqual(self.row()['state'],'unknown')
        row=self.row()
        receipt={'id':row['id'],'text':row['payload'],'target':'lead','attachmentInstance':'wrong',
                 'state':'sent','turnId':'receipt'}
        self.b.control=lambda *a: GOOD if a[0]=='status' else {'inbox':[receipt]}
        self.b.deliver();self.assertEqual(self.row()['state'],'unknown')
        receipt['attachmentInstance']='instance'
        self.b.deliver();self.assertEqual(self.row()['state'],'delivered')

    def test_submitted_stays_service_owned(self):
        self.seed();calls=[]
        def control(*args):
            calls.append(args)
            if args[0]=='status':return GOOD
            if args[0]=='mail':return {'inbox':[]}
            return {'queued':True}
        self.b.control=control;self.b.deliver();self.b.deliver()
        self.assertEqual(self.row()['state'],'submitted')
        self.assertEqual(sum(a[0]=='input' for a in calls),1)

    def test_reconnect_collects_missed_history(self):
        self.b.config['history']='/known/inbox.log'
        self.b.check_source=lambda:None
        def command(argv,**_):
            return ('2026-11-11T06:30:02Z latest\n' if argv[1]=='read' else
                    '2026-11-11T06:29:02Z missed\n2026-11-11T06:30:02Z latest\n')
        self.b.run_command=command
        self.b.catch_up(history=True);self.b.catch_up(history=True)
        self.assertEqual(self.b.db.execute('SELECT count(*) FROM messages').fetchone()[0],2)


if __name__=='__main__':unittest.main()
