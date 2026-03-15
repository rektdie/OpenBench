# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
#                                                                             #
#   OpenBench is a chess engine testing framework authored by Andrew Grant.   #
#   <https://github.com/AndyGrant/OpenBench>           <andrew@grantnet.us>   #
#                                                                             #
#   OpenBench is free software: you can redistribute it and/or modify         #
#   it under the terms of the GNU General Public License as published by      #
#   the Free Software Foundation, either version 3 of the License, or         #
#   (at your option) any later version.                                       #
#                                                                             #
#   OpenBench is distributed in the hope that it will be useful,              #
#   but WITHOUT ANY WARRANTY; without even the implied warranty of            #
#   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the             #
#   GNU General Public License for more details.                              #
#                                                                             #
#   You should have received a copy of the GNU General Public License         #
#   along with this program.  If not, see <http://www.gnu.org/licenses/>.     #
#                                                                             #
# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #

import html
import json
import re, django
import OpenBench.config, OpenBench.utils, OpenBench.stats, OpenBench.models

from django.utils.safestring import mark_safe

def oneDigitPrecision(value):
    try:
        value = round(value, 1)
        if '.' not in str(value):
            return str(value) + '.0'
        pre, post = str(value).split('.')
        post += '0'
        return pre + '.' + post[0:1]
    except:
        return value

def twoDigitPrecision(value):
    try:
        value = round(value, 2)
        if '.' not in str(value):
            return str(value) + '.00'
        pre, post = str(value).split('.')
        post += '00'
        return pre + '.' + post[0:2]
    except:
        return value

def gitDiffLink(test):

    engines = OpenBench.config.OPENBENCH_CONFIG['engines']

    if test.dev_engine in engines and engines[test.dev_engine]['private']:
        repo = OpenBench.config.OPENBENCH_CONFIG['engines'][test.dev_engine]['source']
    else:
        repo = OpenBench.utils.path_join(*test.dev.source.split('/')[:-2])

    if test.test_mode == 'SPSA':
        return OpenBench.utils.path_join(repo, 'compare', test.dev.sha[:8])

    return OpenBench.utils.path_join(repo, 'compare',
        '{0}..{1}'.format( test.base.sha[:8], test.dev.sha[:8]))

def shortStatBlock(test):

    tri_line   = 'Games: %d W: %d L: %d D: %d' % test.as_nwld()
    penta_line = 'Ptnml(0-2): %d, %d, %d, %d, %d' % test.as_penta()

    if test.test_mode == 'SPSA':
        statlines = [
            'Tuning %d Parameters' % (len(test.spsa['parameters'].keys())),
            '%d/%d Iterations' % (test.games / (2 * test.spsa['pairs_per']), test.spsa['iterations']),
            '%d/%d Games Played' % (test.games, 2 * test.spsa['iterations'] * test.spsa['pairs_per'])]

    elif test.test_mode == 'SPRT':
        llr_line = 'LLR: %0.2f (%0.2f, %0.2f) [%0.2f, %0.2f]' % (
            test.currentllr, test.lowerllr, test.upperllr, test.elolower, test.eloupper)
        statlines = [llr_line, tri_line, penta_line] if test.use_penta else [llr_line, tri_line]

    elif test.test_mode == 'GAMES':
        lower, elo, upper = OpenBench.stats.Elo(test.results())
        elo_line = 'Elo: %0.2f +- %0.2f (95%%) [N=%d]' % (elo, max(upper - elo, elo - lower), test.max_games)
        statlines = [elo_line, tri_line, penta_line] if test.use_penta else [elo_line, tri_line]

    elif test.test_mode == 'DATAGEN':
        status_line = 'Generated %d/%d Games' % (test.games, test.max_games)
        lower, elo, upper = OpenBench.stats.Elo(test.results())
        elo_line = 'Elo: %0.2f +- %0.2f (95%%) [N=%d]' % (elo, max(upper - elo, elo - lower), test.max_games)
        statlines = [status_line, elo_line, penta_line] if test.use_penta else [status_line, elo_line, tri_line]

    return '\n'.join(statlines)

def longStatBlock(test):

    assert test.test_mode != 'SPSA'

    threads     = int(OpenBench.utils.extract_option(test.dev_options, 'Threads'))
    hashmb      = int(OpenBench.utils.extract_option(test.dev_options, 'Hash'))
    timecontrol = test.dev_time_control + ['s', '']['=' in test.dev_time_control]
    type_text   = 'SPRT' if test.test_mode == 'SPRT' else 'Conf'

    lower, elo, upper = OpenBench.stats.Elo(test.results())

    lines = [
        'Elo   | %0.2f +- %0.2f (95%%)' % (elo, max(upper - elo, elo - lower)),
        '%-5s | %s Threads=%d Hash=%dMB' % (type_text, timecontrol, threads, hashmb),
    ]

    if test.test_mode == 'SPRT':
        lines.append('LLR   | %0.2f (%0.2f, %0.2f) [%0.2f, %0.2f]' % (
            test.currentllr, test.lowerllr, test.upperllr, test.elolower, test.eloupper))

    lines.append('Games | N: %d W: %d L: %d D: %d' % test.as_nwld())

    if test.use_penta:
        lines.append('Penta | [%d, %d, %d, %d, %d]' % test.as_penta())

    return '\n'.join(lines)

def testResultColour(test):

    if test.passed:
        if test.elolower + test.eloupper < 0: return 'blue'
        return 'green'
    if test.failed:
        if test.wins >= test.losses: return 'yellow'
        return 'red'
    return ''

def sumAttributes(iterable, attribute):
    try: return sum([getattr(f, attribute) for f in iterable])
    except: return 0

def insertCommas(value):
    return '{:,}'.format(int(value))

def prettyName(name):
    if re.search('^[0-9a-fA-F]{40}$', name):
        return name[:16].upper()
    return name

def prettyDevName(test):

    # If engines are different, use the base name + branch
    if test.dev_engine != test.base_engine:
        return '[%s] %s' % (test.base_engine, test.base.name)

    # If testing different Networks, possibly use the Network name
    if test.dev.name == test.base.name and test.dev_netname != '':

        # Nets match as well, so revert back to the branch name
        if test.dev_network == test.base_network:
            return prettyName(test.dev.name)

        # Use the network's name, if we still have it saved
        try: return OpenBench.models.Network.objects.get(sha256=test.dev_network).name
        except: return test.dev_netname # File has since been deleted ?

    return prettyName(test.dev.name)

def testIdToPrettyName(test_id):
    return prettyName(OpenBench.models.Test.objects.get(id=test_id).dev.name)

def testIdToTimeControl(test_id):
    return OpenBench.models.Test.objects.get(id=test_id).dev_time_control

def cpuflagsBlock(machine, N=8):

    reported = []
    flags    = machine.info['cpu_flags']

    general_flags   = ['BMI2', 'POPCNT']
    broad_avx_flags = ['AVX2', 'AVX', 'SSE42', 'SSE41', 'SSSE3']

    for flag in general_flags:
        if flag in flags:
            reported.append(flag)
            break

    for flag in broad_avx_flags:
        if flag in flags:
            reported.append(flag)
            break

    for flag in flags:
        if flag not in general_flags and flag not in broad_avx_flags:
            reported.append(flag)

    return ' '.join(reported)

def compilerBlock(machine):
    string = ''
    for engine, info in machine.info['compilers'].items():
        string += '%-16s %-8s (%s)\n' % (engine, info[0], info[1])
    return string

def removePrefix(value, prefix):
    return value.removeprefix(prefix)

def machine_name(machine_id):
    try:
        machine = OpenBench.models.Machine.objects.get(id=machine_id)
        return machine.info['machine_name']
    except: return 'None'

def llr_history_graph(test, width=320, height=112):

    if test.test_mode != 'SPRT':
        return ''

    history = list(OpenBench.utils.get_llr_history(test))
    if not history:
        history = [[0, 0.0, False], [max(test.games, 1), test.currentllr, False]]
    elif history[-1][0] != test.games or history[-1][1] != test.currentllr:
        history.append([test.games, test.currentllr, False])

    x_max = max(max(point[0] for point in history), 1)
    observed = [point[1] for point in history] + [0.0]
    observed_min = min(observed)
    observed_max = max(observed)
    observed_span = observed_max - observed_min

    if observed_span < 0.75:
        center = (observed_min + observed_max) / 2.0
        y_min = center - 0.375
        y_max = center + 0.375
    else:
        padding = max(observed_span * 0.15, 0.15)
        y_min = observed_min - padding
        y_max = observed_max + padding

    left_pad = 8
    right_pad = 8
    top_pad = 8
    bottom_pad = 8
    inner_width = max(width - left_pad - right_pad, 1)
    inner_height = max(height - top_pad - bottom_pad, 1)

    def scale_x(value):
        return left_pad + inner_width * (value / x_max)

    def scale_y(value):
        return top_pad + inner_height * (1.0 - ((value - y_min) / (y_max - y_min)))

    plotted_points = [
        {
            'games': x,
            'llr': round(y, 4),
            'estimated': estimated,
            'x': round(scale_x(x), 2),
            'y': round(scale_y(y), 2),
        }
        for x, y, estimated in history
    ]
    y_mid = (y_min + y_max) / 2.0
    x_mid = x_max / 2.0
    x_quarter = x_max / 4.0
    x_three_quarter = 3.0 * x_max / 4.0

    grid_lines = []
    for value in [y_max, y_mid, y_min]:
        y_pos = scale_y(value)
        grid_lines.append(
            '<line class="llr-grid-line" x1="%d" y1="%.2f" x2="%d" y2="%.2f"></line>'
            % (left_pad, y_pos, width - right_pad, y_pos)
        )

    for value in [x_quarter, x_mid, x_three_quarter]:
        x_pos = scale_x(value)
        grid_lines.append(
            '<line class="llr-grid-line" x1="%.2f" y1="%d" x2="%.2f" y2="%d"></line>'
            % (x_pos, top_pad, x_pos, height - bottom_pad)
        )

    def interpolate_zero_crossing(a, b):
        if a['llr'] == b['llr']:
            return None

        ratio = (0.0 - a['llr']) / (b['llr'] - a['llr'])
        if ratio < 0.0 or ratio > 1.0:
            return None

        x_pos = a['x'] + ratio * (b['x'] - a['x'])
        return {
            'games': a['games'] + ratio * (b['games'] - a['games']),
            'llr': 0.0,
            'x': round(x_pos, 2),
            'y': round(scale_y(0.0), 2),
        }

    positive_segments = []
    negative_segments = []
    current_segment = [plotted_points[0]]
    current_positive = plotted_points[0]['llr'] >= 0.0

    for index in range(1, len(plotted_points)):
        prev_point = plotted_points[index - 1]
        point = plotted_points[index]
        point_positive = point['llr'] >= 0.0

        if point_positive == current_positive:
            current_segment.append(point)
            continue

        crossing = interpolate_zero_crossing(prev_point, point)
        if crossing:
            current_segment.append(crossing)

        if len(current_segment) >= 2:
            if current_positive:
                positive_segments.append(current_segment)
            else:
                negative_segments.append(current_segment)

        current_segment = [crossing, point] if crossing else [point]
        current_positive = point_positive

    if len(current_segment) >= 2:
        if current_positive:
            positive_segments.append(current_segment)
        else:
            negative_segments.append(current_segment)

    positive_paths = ''.join(
        '<polyline class="llr-path-positive" points="%s"></polyline>' % (
            ' '.join('%.2f,%.2f' % (point['x'], point['y']) for point in segment)
        )
        for segment in positive_segments
    )
    negative_paths = ''.join(
        '<polyline class="llr-path-negative" points="%s"></polyline>' % (
            ' '.join('%.2f,%.2f' % (point['x'], point['y']) for point in segment)
        )
        for segment in negative_segments
    )

    guides = []
    for value, css_class in [
        (test.lowerllr, 'llr-boundary'),
        (0.0, 'llr-zero'),
        (test.upperllr, 'llr-boundary'),
    ]:
        if y_min <= value <= y_max:
            y_pos = scale_y(value)
            guides.append(
                '<line class="%s" x1="%d" y1="%.2f" x2="%d" y2="%.2f"></line>'
                % (css_class, left_pad, y_pos, width - right_pad, y_pos)
            )

    latest_x = plotted_points[-1]['x']
    latest_y = plotted_points[-1]['y']
    title = 'LLR history: current %.2f after %d games' % (test.currentllr, test.games)
    history_json = html.escape(json.dumps(plotted_points, separators=(',', ':')))

    svg = '''
        <div class="llr-history-widget" data-history="{history_json}">
            <div class="llr-history-chart">
                <div class="llr-history-yaxis">
                    <div>{y_max_label}</div>
                    <div>{y_mid_label}</div>
                    <div>{y_min_label}</div>
                </div>
                <div class="llr-history-main">
                    <div class="llr-history-plot">
                        <svg class="llr-history-graph" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" aria-label="{title}">
                            <title>{title}</title>
                            <rect class="llr-bg" x="0" y="0" width="{width}" height="{height}" rx="6"></rect>
                            {grid_lines}
                            {guides}
                            {positive_paths}
                            {negative_paths}
                            <line class="llr-hover-line" x1="{latest_x:.2f}" y1="{top_pad:.2f}" x2="{latest_x:.2f}" y2="{hover_bottom:.2f}"></line>
                            <circle class="llr-hover-point" cx="{latest_x:.2f}" cy="{latest_y:.2f}" r="3"></circle>
                            <rect class="llr-hitbox" x="0" y="0" width="{width}" height="{height}" rx="6"></rect>
                        </svg>
                        <div class="llr-history-tooltip"></div>
                    </div>
                    <div class="llr-history-xaxis">
                        <div>0</div>
                        <div>{x_mid_label}</div>
                        <div>{x_max_label}</div>
                    </div>
                </div>
            </div>
        </div>
    '''.format(
        width=width,
        height=height,
        title=html.escape(title),
        history_json=history_json,
        grid_lines=''.join(grid_lines),
        guides=''.join(guides),
        positive_paths=positive_paths,
        negative_paths=negative_paths,
        latest_x=latest_x,
        latest_y=latest_y,
        top_pad=top_pad,
        hover_bottom=height - bottom_pad,
        y_max_label=html.escape('%.2f' % (y_max)),
        y_mid_label=html.escape('%.2f' % (y_mid)),
        y_min_label=html.escape('%.2f' % (y_min)),
        x_mid_label=html.escape('%d' % (round(x_mid))),
        x_max_label=html.escape('%d g' % (x_max)),
    )

    return mark_safe(svg)


register = django.template.Library()
register.filter('oneDigitPrecision', oneDigitPrecision)
register.filter('twoDigitPrecision', twoDigitPrecision)
register.filter('gitDiffLink', gitDiffLink)
register.filter('shortStatBlock', shortStatBlock)
register.filter('longStatBlock', longStatBlock)
register.filter('testResultColour', testResultColour)
register.filter('sumAttributes', sumAttributes)
register.filter('insertCommas', insertCommas)
register.filter('prettyName', prettyName)
register.filter('prettyDevName', prettyDevName)
register.filter('testIdToPrettyName', testIdToPrettyName)
register.filter('testIdToTimeControl', testIdToTimeControl)
register.filter('cpuflagsBlock', cpuflagsBlock)
register.filter('compilerBlock', compilerBlock)
register.filter('removePrefix', removePrefix)
register.filter('machine_name', machine_name)
register.filter('llr_history_graph', llr_history_graph)

####

def spsa_param_digest(workload):

    digest = []

    # C and R are compressed as we progress iterations
    iteration     = 1 + (workload.games / (workload.spsa['pairs_per'] * 2))
    c_compression = iteration ** workload.spsa['Gamma']
    r_compression = (workload.spsa['A'] + iteration) ** workload.spsa['Alpha']

    # Maintain the original order, if there was one
    keys = sorted(
        workload.spsa['parameters'].keys(),
        key=lambda x: workload.spsa['parameters'][x].get('index', -1)
    )

    for name in keys:

        param = workload.spsa['parameters'][name]

        # C and R if we got a workload right now
        c = max(param['c'] / c_compression, 0.00 if param['float'] else 0.50)
        r = param['a'] / r_compression / c ** 2

        fstr = '%.4f' if param['float'] else '%d'

        digest.append([
            name,
            '%.4f' % (param['value']),
            fstr   % (param['start']),
            fstr   % (param['min'  ]),
            fstr   % (param['max'  ]),
            '%.4f' % (c),
            '%.4f' % (param['c_end']),
            '%.4f' % (r),
            '%.4f' % (param['r_end']),
        ])

    return digest

def spsa_param_digest_headers(workload):
    return ['Name', 'Curr', 'Start', 'Min', 'Max', 'C', 'C_end', 'R', 'R_end']

def spsa_original_input(workload):

    # Maintain the original order, if there was one
    keys = sorted(
        workload.spsa['parameters'].keys(),
        key=lambda x: workload.spsa['parameters'][x].get('index', -1)
    )

    lines = []
    for name in keys:

        param = workload.spsa['parameters'][name]
        dtype = 'float' if param['float'] else 'int'

        # Original 7 token Input
        lines.append(', '.join([
            name,
            dtype,
            str(param['start']),
            str(param['min'  ]),
            str(param['max'  ]),
            str(param['c_end']),
            str(param['r_end']),
        ]))

    return '\n'.join(lines)

def spsa_optimal_values(workload):

    # Maintain the original order, if there was one
    keys = sorted(
        workload.spsa['parameters'].keys(),
        key=lambda x: workload.spsa['parameters'][x].get('index', -1)
    )

    lines = []
    for name in keys:
        param = workload.spsa['parameters'][name]
        value = param['value'] if param['float'] else round(param['value'])
        lines.append(', '.join([name, str(value)]))

    return '\n'.join(lines)


def book_download_link(workload):
    if workload.book_name in OpenBench.config.OPENBENCH_CONFIG['books']:
        return OpenBench.config.OPENBENCH_CONFIG['books'][workload.book_name]['source']

def network_download_link(workload, branch):

    assert branch in [ 'dev', 'base' ]

    sha    = workload.dev_network if branch == 'dev' else workload.base_network
    engine = workload.dev_engine  if branch == 'dev' else workload.base_engine

    # Network could have been deleted after this workload was finished
    if (network := OpenBench.models.Network.objects.filter(sha256=sha, engine=engine).first()):
        return '/networks/%s/download/%s/' % (engine, sha)

    return '/networks/%s/' % (engine)

def workload_url(workload):

    # Might be a workload id
    if type(workload) == int:
        workload = OpenBench.models.Test.objects.get(id=workload)

    # Differentiate between Tunes ( SPSA ) and Tests ( SPRT / Fixed )
    return '/%s/%d/' % ('tune' if workload.test_mode == 'SPSA' else 'test', workload.id)

def workload_pretty_name(workload):

    # Might be a workload id
    if type(workload) == int:
        workload = OpenBench.models.Test.objects.get(id=workload)

    # Convert commit sha's to just the first 16 characters
    if re.search('^[0-9a-fA-F]{40}$', workload.dev.name):
        return workload.dev.name[:16].lower()

    return workload.dev.name

def git_diff_text(workload, N=24):

    dev_name = workload.dev.name
    dev_name = dev_name[:N] + '...' if len(dev_name) > N else dev_name

    base_name = workload.base.name
    base_name = base_name[:N] + '...' if len(base_name) > N else base_name

    return '%s vs %s' % (dev_name, base_name)


def test_is_smp_odds(test):
    dev_threads  = int(OpenBench.utils.extract_option(test.dev_options , 'Threads'))
    base_threads = int(OpenBench.utils.extract_option(test.base_options, 'Threads'))
    return dev_threads != base_threads

def test_is_time_odds(test):
    return test.dev_time_control != test.base_time_control

def test_is_fischer(test):
    return 'FRC' in test.book_name.upper() or '960' in test.book_name.upper()


register.filter('spsa_param_digest', spsa_param_digest)
register.filter('spsa_param_digest_headers', spsa_param_digest_headers)
register.filter('spsa_original_input', spsa_original_input)
register.filter('spsa_optimal_values', spsa_optimal_values)

register.filter('book_download_link', book_download_link)
register.filter('network_download_link', network_download_link)

register.filter('workload_url', workload_url)
register.filter('workload_pretty_name', workload_pretty_name)

register.filter('git_diff_text', git_diff_text)

register.filter('test_is_smp_odds'  , test_is_smp_odds  )
register.filter('test_is_time_odds' , test_is_time_odds )
register.filter('test_is_fischer'   , test_is_fischer   )


@register.filter
def next(iterable, index):
    try: return iterable[int(index) + 1]
    except: return None

@register.filter
def previous(iterable, index):
    try: return iterable[int(index) - 1]
    except: return None
