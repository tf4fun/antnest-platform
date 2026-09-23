"""The 20260917 final contract; no Runtime replacement or extra Trace gate."""
from pathlib import PurePosixPath
from controller_evidence import AGENT, SESSION
from development_configuration import development_children, file_path, read_json, require, text


WORKSPACE_READ = 'resolved=$(readlink -f "$1") || exit; case "$resolved" in */.cache|*/.cache/*) exit 1;; /workspace/*) cat -- "$resolved";; *) exit 1;; esac'


def controller17_reports(config):
    reports={key:read_json(config['reports'][key]) for key in ('browser','agentBefore','agentFinal','temporaryAgent','lifecycle')}
    browser=reports['browser'];agent=text(browser.get('agent_id'),'browser Agent',AGENT)
    text(browser.get('session_id'),'browser Session',SESSION)
    require(config['workspace']['container']=='antnest-runtime-'+agent,'workspace Agent differs from browser')
    require(isinstance(browser.get('checks'),list) and len(browser['checks'])==8 and browser.get('browser_errors')==0,'incomplete browser checks')
    marker=text(browser.get('workspace_file'),'workspace file');parts=PurePosixPath(marker).parts
    require(marker.startswith('/workspace/') and '..' not in parts and '.cache' not in parts,'marker must stay in workspace outside cache')
    text(browser.get('workspace_marker'),'workspace marker')
    paths=[file_path(config['reports'][key]) for key in ('agentBefore','agentFinal')]
    require((paths[0].stat().st_dev,paths[0].stat().st_ino)!=(paths[1].stat().st_dev,paths[1].stat().st_ino),'Agent snapshots must be distinct files')
    before,final=[dict(reports[key]) for key in ('agentBefore','agentFinal')]
    for snapshot in (before,final):
        require(snapshot.get('agent_id')==agent,'Agent snapshot identity differs from browser')
        text(snapshot.pop('checked_at',None),'Agent checked_at')
    require(before==final,'Agent configuration changed')
    temp=text(reports['temporaryAgent'].get('agent_id'),'temporary Agent',AGENT)
    require(temp!=agent,'temporary Agent must differ from retained Agent')
    lifecycle=reports['lifecycle']
    require(lifecycle.get('status')=='passed' and isinstance(lifecycle.get('lifecycle'),list),'lifecycle did not pass')
    for item in lifecycle['lifecycle']:
        warnings=item['evidence']['warnings']
        require(isinstance(warnings,list) and all(isinstance(w,str) and w.startswith('clock skew adjustment disabled') for w in warnings),'unexpected lifecycle warning')
    return reports


def controller17_acceptance(config,sql,run,runtime):
    reports=controller17_reports(config);browser=reports['browser'];session=browser['session_id']
    binding=read_sql(sql,f"SELECT jsonb_build_object('agent_id',agent_id,'cwd',cwd) FROM acp_sessions WHERE id='{session}';")
    require(binding==dict(agent_id=browser['agent_id'],cwd='/workspace'),'Session ownership or workspace changed')
    runs=read_sql(sql,f"SELECT jsonb_agg(jsonb_build_object('state',state,'stop_reason',stop_reason,'executor_state',executor_state)) FROM runs WHERE session_id='{session}';")
    require(isinstance(runs,list) and len(runs)==3 and all(row==dict(state='completed',stop_reason='end_turn',executor_state='quiescent') for row in runs),'expected three completed runs')
    attempts=read_sql(sql,f"SELECT jsonb_agg(jsonb_build_object('tool',t.tool_name,'state',t.state,'effect',t.tool_effect_state)) FROM tool_attempts t JOIN runs r ON r.id=t.run_id WHERE r.session_id='{session}';")
    require(isinstance(attempts,list) and len(attempts)==3 and all(row['state']=='completed' and row['effect']=='settled' for row in attempts),'expected three settled tool attempts')
    rejected=read_sql(sql,f"SELECT jsonb_agg(payload) FROM session_messages WHERE session_id='{session}' AND kind='tool_call' AND payload->>'status'='failed';")
    require(isinstance(rejected,list) and len(rejected)==2,'expected two preflight rejections')
    for row in rejected:
        require(all(item['text'].startswith('Tool arguments do not match the declared schema:') for item in row['content']),'unexpected tool failure')
        call=text(row['toolCallId'],'rejected tool call ID',r'[a-zA-Z0-9_-]+')
        require(sql("SELECT count(*) FROM tool_attempts WHERE tool_call_id='"+call+"';")=='0','preflight rejection dispatched a tool')
    content=run(['docker','exec',runtime['Id'],'sh','-c',WORKSPACE_READ,'sh',browser['workspace_file']],text=True)
    require(content==browser['workspace_marker'],'workspace marker changed')
    temp=reports['temporaryAgent']['agent_id']
    for command in (['ps','-aq'],['volume','ls','-q'],['network','ls','-q']):
        for scope in ('label=io.antnest.agent-id='+temp,'name='+temp):
            require(not run(['docker',*command,'--filter',scope],text=True).strip(),'temporary Agent resources remain')
    require(not development_children('controller-20260917',run(['ps','-axo','pid=,ppid=,command='],text=True)),'verification children remain')
    return dict(session_id=session,new_completed_runs=3,completed_runtime_calls=3,preflight_rejections=2,workspace_marker_matches=True,agent_configuration_unchanged=True,temporary_resources=0,verification_children=0)


def read_sql(sql,query):
    import json
    return json.loads(sql(query))
