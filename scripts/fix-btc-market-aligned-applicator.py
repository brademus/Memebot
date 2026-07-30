from pathlib import Path

path = Path(__file__).with_name('apply-btc-market-aligned-v3.py')
text = path.read_text()
old = '''text = replace_once(text,
"""    if (!(estimatedRewardUsd > 0)) {
      failures.add('native strategy target does not remain profitable after estimated costs');
      continue;
    }
""", '', 'risk remove duplicate reward check')'''
new = '''reward_check = """    if (!(estimatedRewardUsd > 0)) {
      failures.add('native strategy target does not remain profitable after estimated costs');
      continue;
    }
"""
first_reward_check = text.find(reward_check)
second_reward_check = text.find(reward_check, first_reward_check + 1)
if first_reward_check < 0 or second_reward_check < 0:
    raise RuntimeError('risk duplicate reward check: expected two blocks after insertion')
text = text[:second_reward_check] + text[second_reward_check + len(reward_check):]'''
if old not in text:
    raise RuntimeError('applicator target block not found')
path.write_text(text.replace(old, new, 1))
print('Corrected BTC applicator duplicate reward-check transform')
